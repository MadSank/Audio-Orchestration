package com.saics.player.engine

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.ShortBuffer
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

const val ENGINE_RATE = 44100

/**
 * A whole song as 16-bit stereo PCM at [ENGINE_RATE], off the Java heap (~10.6 MB per minute).
 * Forever jumps reach back to any bar, so the song stays in memory while it plays.
 * One decoder thread writes; the render thread reads below [frames] only.
 */
class Pcm(val capacity: Int) {
  private val buf: ShortBuffer =
    ByteBuffer.allocateDirect(capacity * 4).order(ByteOrder.nativeOrder()).asShortBuffer()

  @Volatile var frames = 0 // decoded so far
    private set
  @Volatile var complete = false
  @Volatile var failed = false
  @Volatile var cancelled = false

  fun left(frame: Int): Float = buf.get(frame * 2) * SCALE
  fun right(frame: Int): Float = buf.get(frame * 2 + 1) * SCALE

  /** Decoder side: append one frame; false when full. */
  fun put(l: Float, r: Float): Boolean {
    val f = frames
    if (f >= capacity) return false
    buf.put(f * 2, q(l))
    buf.put(f * 2 + 1, q(r))
    frames = f + 1
    return true
  }

  /** Decoder side: publish in batches would be cheaper; frames is volatile per frame for simplicity. */
  private fun q(x: Float): Short = (x.coerceIn(-1f, 1f) * 32767f).toInt().toShort()

  companion object {
    private const val SCALE = 1f / 32768f

    fun forSeconds(seconds: Double): Pcm =
      Pcm(((seconds * 1.02 + 2.0) * ENGINE_RATE).toInt().coerceAtLeast(ENGINE_RATE))
  }
}

/**
 * Streaming windowed-sinc resampler (Kaiser, 32 taps, 512 interpolated phases) for the
 * 48 kHz files (D15). Runs on the decoder thread.
 */
class Resampler(private val inRate: Int, private val outRate: Int = ENGINE_RATE) {
  private val step = inRate.toDouble() / outRate
  private val cutoff = 0.5 * min(1.0, outRate.toDouble() / inRate) * 0.97 // cycles per input sample
  private val table = DoubleArray((PHASES + 1) * TAPS)
  private val histL = FloatArray(HIST)
  private val histR = FloatArray(HIST)
  private var have = 0 // samples in history
  private var pos = 0.0 // next output position, in history coordinates (t = 0 at the first input)

  init {
    for (p in 0..PHASES) {
      val frac = p.toDouble() / PHASES
      for (k in 0 until TAPS) {
        val x = k - (TAPS / 2 - 1) - frac
        val sinc = if (abs(x) < 1e-9) 2 * cutoff else sin(2 * PI * cutoff * x) / (PI * x)
        val w = kaiser(x / (TAPS / 2.0))
        table[p * TAPS + k] = sinc * w
      }
    }
  }

  private fun kaiser(t: Double): Double {
    if (abs(t) > 1) return 0.0
    return bessel0(BETA * sqrt(1 - t * t)) / bessel0(BETA)
  }

  private fun bessel0(x: Double): Double {
    var sum = 1.0
    var term = 1.0
    var k = 1
    while (term > 1e-12 * sum) {
      term *= (x / (2 * k)) * (x / (2 * k))
      sum += term
      k++
    }
    return sum
  }

  /** Feed one input frame; resampled frames go to [out]. Returns false if [out] is full. */
  fun push(l: Float, r: Float, out: Pcm): Boolean {
    if (have == HIST) {
      // Slide the history, keeping what the filter still needs.
      val keep = TAPS + 2
      val drop = (floor(pos).toInt() - (TAPS / 2 - 1)).coerceIn(0, HIST - keep)
      System.arraycopy(histL, drop, histL, 0, HIST - drop)
      System.arraycopy(histR, drop, histR, 0, HIST - drop)
      have -= drop
      pos -= drop
    }
    histL[have] = l
    histR[have] = r
    have++
    while (floor(pos).toInt() + TAPS / 2 < have) {
      val i0 = floor(pos).toInt()
      val frac = pos - i0
      val ph = frac * PHASES
      val p0 = ph.toInt()
      val pf = ph - p0
      var accL = 0.0
      var accR = 0.0
      val base = i0 - (TAPS / 2 - 1)
      for (k in 0 until TAPS) {
        val idx = base + k
        if (idx < 0) continue
        val h = table[p0 * TAPS + k] * (1 - pf) + table[(p0 + 1) * TAPS + k] * pf
        accL += histL[idx] * h
        accR += histR[idx] * h
      }
      if (!out.put(accL.toFloat(), accR.toFloat())) return false
      pos += step
    }
    return true
  }

  companion object {
    private const val TAPS = 32
    private const val PHASES = 512
    private const val HIST = 8192
    private const val BETA = 8.6
  }
}
