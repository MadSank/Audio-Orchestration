package com.saics.player.engine

import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Streaming port of versions.py `_apply_vinyl_crackle` (the owner's blind vinyl pick, Q2),
 * one instance per channel. Parameters are copied exactly (hard rule 5):
 * - 200 Hz-8 kHz band-pass, 3rd-order Butterworth, blended 70/30 with dry;
 * - crackle: ~8 pops/s (exponential(0.5) amplitude, clipped to 1; 0.5-2 ms noise bursts with a
 *   linear decay) + white noise * 0.08 through an 800 Hz-5 kHz 2nd-order band-pass; added * 0.03;
 * - wow: 0.5 Hz, +-1.5 ms modulated delay with linear interpolation;
 * - 12 kHz 2nd-order low-pass.
 * The offline version reads up to 1.5 ms *ahead* in the wow stage; here the delay line adds a
 * constant 2 ms latency instead, which doesn't change the sound.
 *
 * Real-time safe: all state is preallocated; `process` allocates nothing.
 */
class Vinyl(private val sr: Double, seed: Long) {
  private val bp = Sos(Butter.sos(3, doubleArrayOf(min(200.0, sr / 2 * 0.9), min(8000.0, sr / 2 * 0.9)), "band", sr))
  private val hissBp = Sos(Butter.sos(2, doubleArrayOf(min(800.0, sr / 2 * 0.9), min(5000.0, sr / 2 * 0.9)), "band", sr))
  private val lp = Sos(Butter.sos(2, doubleArrayOf(min(12000.0, sr / 2 * 0.95)), "low", sr))
  private val rng = Rng(seed)

  // Pops: a handful of overlapping bursts at most (8/s, <= 2 ms each).
  private val popLeft = IntArray(MAX_POPS)
  private val popLen = IntArray(MAX_POPS)
  private val popAmp = DoubleArray(MAX_POPS)
  private val popProb = 8.0 / sr

  // Wow delay line.
  private val depth = WOW_DEPTH_MS * sr / 1000
  private val base = ceil(depth) + 2
  private val line = DoubleArray(Integer.highestOneBit((2 * base + 4).toInt()) * 2)
  private val mask = line.size - 1
  private var w = 0
  private var phase = 0.0
  private val dPhase = 2 * PI * WOW_RATE_HZ / sr

  fun reset() {
    bp.reset(); hissBp.reset(); lp.reset()
    popLen.fill(0)
    line.fill(0.0)
    phase = 0.0
  }

  fun process(x: Double): Double {
    var s = 0.7 * bp.process(x) + 0.3 * x
    s += crackle() * 0.03
    // Wow/flutter: out = in[t - base - depth*sin] (linear interpolation).
    line[w] = s
    val d = base + depth * sin(phase)
    phase += dPhase
    if (phase > 2 * PI) phase -= 2 * PI
    val pos = w - d
    val i0 = floor(pos)
    val frac = pos - i0
    val a = line[i0.toInt() and mask]
    val b = line[(i0.toInt() + 1) and mask]
    w = (w + 1) and mask
    return lp.process(a * (1 - frac) + b * frac)
  }

  private fun crackle(): Double {
    var c = 0.0
    if (rng.uniform() < popProb) {
      val slot = popLen.indexOfFirst { it == 0 }.let { if (it < 0) 0 else it }
      val amp = min(1.0, -0.5 * ln(1.0 - rng.uniform())) // exponential(scale 0.5), clipped
      val len = (rng.uniform(0.0005, 0.002) * sr).toInt()
      if (len > 0) {
        popLen[slot] = len; popLeft[slot] = len; popAmp[slot] = amp
      }
    }
    for (i in 0 until MAX_POPS) {
      val left = popLeft[i]
      if (left > 0) {
        val env = (left - 1).toDouble() / maxOf(1, popLen[i] - 1) // linspace(1, 0)
        c += rng.gauss() * popAmp[i] * env
        popLeft[i] = left - 1
        if (left == 1) popLen[i] = 0
      }
    }
    c += hissBp.process(rng.gauss() * 0.08)
    return c
  }

  companion object {
    const val WOW_RATE_HZ = 0.5
    const val WOW_DEPTH_MS = 1.5
    private const val MAX_POPS = 8
  }
}

/** xorshift64* with Box-Muller; allocation-free and lock-free (unlike java.util.Random). */
class Rng(seed: Long) {
  private var s = if (seed == 0L) 0x9E3779B97F4A7C15uL.toLong() else seed
  private var spare = 0.0
  private var hasSpare = false

  fun next(): Long {
    s = s xor (s ushr 12); s = s xor (s shl 25); s = s xor (s ushr 27)
    return s * 0x2545F4914F6CDD1DL
  }

  fun uniform(): Double = (next() ushr 11) * (1.0 / (1L shl 53))
  fun uniform(a: Double, b: Double) = a + (b - a) * uniform()

  fun gauss(): Double {
    if (hasSpare) {
      hasSpare = false
      return spare
    }
    val u = 1.0 - uniform()
    val v = uniform()
    val r = sqrt(-2 * ln(u))
    spare = r * sin(2 * PI * v)
    hasSpare = true
    return r * cos(2 * PI * v)
  }
}
