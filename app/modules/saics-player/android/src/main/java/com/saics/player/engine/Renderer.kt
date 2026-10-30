package com.saics.player.engine

import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh

/**
 * "At frame [at] of the song in slot [from], continue at frame [to] of slot [toSlot]", with a
 * crossfade centred on the seam as render.py `render_segments` does: the outgoing audio runs
 * on [half] frames past [at], the incoming starts [half] frames before [to]. [rho] is the
 * correlation of the two windows (1 = identical audio: amplitude-linear, no +3 dB bump).
 * [gap] frames of silence go before the incoming audio (repeat-one). [at] < 0 = right now.
 * Immutable; created by the scheduler, handed to the render thread through [Renderer.pending].
 */
class Instruction(
  val from: Int,
  val at: Int,
  val toSlot: Int,
  val to: Int,
  val half: Int,
  val rho: Double = 0.0,
  val gap: Int = 0,
  val tag: Int = 0, // what it is, for the scheduler's bookkeeping (jump, version, track, ...)
)

/** A song loaded for playback; the scheduler fills slots, the renderer only reads them. */
class Slot {
  @Volatile var pcm: Pcm? = null
  @Volatile var gain = 1f // linear, from gain_db (may exceed 1; the output limiter catches peaks)
}

/**
 * The render core, run on the audio thread. It plays the current slot linearly and executes
 * the pending [Instruction] sample-accurately. No allocations, locks, logging or JNI here
 * (hard rule 9); all hand-over is through volatile fields and one [AtomicReference].
 * If no instruction arrives in time, playback simply continues: a late decision never gaps.
 */
class Renderer(val slots: Array<Slot>) {
  val pending = AtomicReference<Instruction?>(null)

  // Published for the scheduler / UI (written once per block).
  @Volatile var slot = -1
    private set
  @Volatile var frame = 0
    private set
  @Volatile var executed = 0 // instructions executed so far
    private set
  @Volatile var armedSlot = -1 // slot an armed/running instruction will use
    private set
  @Volatile var atEnd = false // the current song ran out with nothing to follow
    private set

  // Controls (written by other threads).
  @Volatile var playing = false
  @Volatile var duck = 1f
  @Volatile var vinylOn = false
  @Volatile var vinylComp = 1f

  /** Effective output level after the pause/resume ramp (the play thread parks at 0). */
  var fade = 0f
    private set

  private var cur = -1
  private var pos = 0
  private var armed: Instruction? = null
  // crossfade state
  private var xf: Instruction? = null
  private var xfK = 0
  private var xfFromPos = 0
  private var xfToPos = 0
  private var gapLeft = 0
  private var wet = 0f
  private var duckNow = 1f
  private val vinylL = Vinyl(ENGINE_RATE.toDouble(), 0x5A1C5L)
  private val vinylR = Vinyl(ENGINE_RATE.toDouble(), 0x7E57L)

  /** Fills [out] (interleaved stereo) with [frames] frames. */
  fun render(out: FloatArray, frames: Int) {
    arm(frames)
    val fadeStep = 1f / (FADE_S * ENGINE_RATE)
    val wetStep = 1f / (VINYL_XFADE_S * ENGINE_RATE)
    val target = if (playing) 1f else 0f
    val vinylTarget = if (vinylOn) 1f else 0f
    for (i in 0 until frames) {
      // 1. An armed instruction starts exactly half a crossfade before its seam.
      if (xf == null && gapLeft == 0) {
        val ins = armed
        if (ins != null && (ins.at < 0 || pos >= ins.at - ins.half)) start(ins)
      }
      // 2. Produce one frame: gap silence, a crossfade, or the current song.
      var l = 0f
      var r = 0f
      val x = xf
      if (gapLeft > 0) {
        if (--gapLeft == 0) finishGap()
      } else if (x != null) {
        val n = 2 * x.half
        val th = (xfK + 0.5) / n * (PI / 2)
        val norm = sqrt(1.0 + x.rho * sin(2 * th))
        val fo = (cos(th) / norm).toFloat()
        val fi = (sin(th) / norm).toFloat()
        val a = slots[x.from]
        val b = slots[x.toSlot]
        l = sampleL(a, xfFromPos) * a.gain * fo + sampleL(b, xfToPos) * b.gain * fi
        r = sampleR(a, xfFromPos) * a.gain * fo + sampleR(b, xfToPos) * b.gain * fi
        xfFromPos++
        xfToPos++
        if (++xfK >= n) {
          cur = x.toSlot
          pos = xfToPos
          xf = null
          armedSlot = -1
          executed++
        }
      } else if (cur >= 0) {
        val s = slots[cur]
        val p = s.pcm
        if (p != null && pos < p.frames) {
          l = p.left(pos) * s.gain
          r = p.right(pos) * s.gain
          pos++
        } else {
          atEnd = p != null && p.complete
        }
      }
      // Vinyl (versions.py chain) with a 200 ms dry/wet crossfade.
      if (wet != vinylTarget) {
        wet = if (wet < vinylTarget) minOf(vinylTarget, wet + wetStep) else maxOf(vinylTarget, wet - wetStep)
        if (wet == 0f) {
          vinylL.reset(); vinylR.reset()
        }
      }
      if (wet > 0f) {
        val vl = vinylL.process(l.toDouble()).toFloat() * vinylComp
        val vr = vinylR.process(r.toDouble()).toFloat() * vinylComp
        l = l * (1 - wet) + vl * wet
        r = r * (1 - wet) + vr * wet
      }
      // Pause/resume ramp, ducking, and a soft limiter for boosted (quiet) songs.
      fade = if (fade < target) minOf(target, fade + fadeStep) else maxOf(target, fade - fadeStep)
      duckNow += (duck - duckNow) * 0.0005f
      val g = fade * duckNow
      out[2 * i] = limit(l * g)
      out[2 * i + 1] = limit(r * g)
    }
    slot = cur
    frame = pos
  }

  private fun start(ins: Instruction) {
    armed = null
    val late = if (ins.at < 0) 0 else maxOf(0, pos - (ins.at - ins.half))
    if (ins.gap > 0) {
      gapLeft = ins.gap
      xf = null
      pendingAfterGap = ins
      return
    }
    if (ins.half <= 0 || cur < 0) {
      cur = ins.toSlot
      pos = ins.to + late
      armedSlot = -1
      executed++
      return
    }
    xf = ins
    xfK = 0
    xfFromPos = pos
    xfToPos = ins.to - ins.half + late
    if (xfToPos < 0) xfToPos = 0
  }

  private var pendingAfterGap: Instruction? = null

  private fun finishGap() {
    val ins = pendingAfterGap ?: return
    pendingAfterGap = null
    cur = ins.toSlot
    pos = ins.to
    armedSlot = -1
    executed++
  }

  /** Take the pending instruction once it is due within the next block (it can no longer change). */
  private fun arm(frames: Int) {
    val p = pending.get() ?: return
    if (armed != null || xf != null || gapLeft > 0) return
    if (p.from != cur && !(p.at < 0)) {
      pending.compareAndSet(p, null) // stale: written for a song that is no longer playing
      return
    }
    if (p.at < 0 || pos + frames + ARM_AHEAD >= p.at - p.half) {
      if (pending.compareAndSet(p, null)) {
        armed = p
        armedSlot = p.toSlot
        atEnd = false
      }
    }
  }

  private fun sampleL(s: Slot, f: Int): Float {
    val p = s.pcm ?: return 0f
    return if (f in 0 until p.frames) p.left(f) else 0f
  }

  private fun sampleR(s: Slot, f: Int): Float {
    val p = s.pcm ?: return 0f
    return if (f in 0 until p.frames) p.right(f) else 0f
  }

  private fun limit(x: Float): Float {
    val a = if (x < 0) -x else x
    if (a <= KNEE) return x
    val y = KNEE + (1 - KNEE) * tanh((a - KNEE) / (1 - KNEE)).toFloat()
    return if (x < 0) -y else y
  }

  companion object {
    const val FADE_S = 0.1f
    const val VINYL_XFADE_S = 0.2f
    const val ARM_AHEAD = 512
    private const val KNEE = 0.9f
  }
}
