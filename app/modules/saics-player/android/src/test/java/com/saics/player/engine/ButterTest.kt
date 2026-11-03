package com.saics.player.engine

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/** The filter designs match scipy.signal.butter (reference magnitudes from sosfreqz). */
class ButterTest {
  private val freqs = doubleArrayOf(50.0, 200.0, 1000.0, 3000.0, 8000.0, 12000.0, 18000.0)

  private fun magnitude(sos: Array<DoubleArray>, f: Double, sr: Double): Double {
    val w = 2 * PI * f / sr
    var re = 1.0
    var im = 0.0
    for (s in sos) {
      // H = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2), z = e^{jw}
      val nr = s[0] + s[1] * cos(w) + s[2] * cos(2 * w)
      val ni = -s[1] * sin(w) - s[2] * sin(2 * w)
      val dr = 1 + s[4] * cos(w) + s[5] * cos(2 * w)
      val di = -s[4] * sin(w) - s[5] * sin(2 * w)
      val d = dr * dr + di * di
      val hr = (nr * dr + ni * di) / d
      val hi = (ni * dr - nr * di) / d
      val r2 = re * hr - im * hi
      im = re * hi + im * hr
      re = r2
    }
    return hypot(re, im)
  }

  private fun check(order: Int, wn: DoubleArray, type: String, sr: Double, want: DoubleArray) {
    val sos = Butter.sos(order, wn, type, sr)
    freqs.forEachIndexed { i, f ->
      assertEquals("$type $order ${wn.toList()} @$sr ${f}Hz", want[i], magnitude(sos, f, sr), 2e-5)
    }
  }

  @Test fun vinylBandPass44() = check(3, doubleArrayOf(200.0, 8000.0), "band", 44100.0,
    doubleArrayOf(0.014662, 0.707107, 1.000000, 0.999763, 0.707107, 0.163133, 0.006447))

  @Test fun vinylBandPass48() = check(3, doubleArrayOf(200.0, 8000.0), "band", 48000.0,
    doubleArrayOf(0.014644, 0.707107, 1.000000, 0.999731, 0.707107, 0.180762, 0.012816))

  @Test fun hissBandPass() = check(2, doubleArrayOf(800.0, 5000.0), "band", 44100.0,
    doubleArrayOf(0.002797, 0.045531, 0.888952, 0.989896, 0.259485, 0.077331, 0.008773))

  @Test fun lowPass12k() = check(2, doubleArrayOf(12000.0), "low", 44100.0,
    doubleArrayOf(1.000000, 1.000000, 0.999993, 0.999365, 0.954949, 0.707107, 0.115622))

  @Test fun highPass6k() = check(2, doubleArrayOf(6000.0), "high", 48000.0,
    doubleArrayOf(0.000062, 0.000999, 0.025031, 0.224711, 0.889131, 0.985599, 0.999567))

  @Test fun lowPass80Hz4thOrder() = check(4, doubleArrayOf(80.0), "low", 44100.0,
    doubleArrayOf(0.988558, 0.025586, 0.000041, 0.0, 0.0, 0.0, 0.0))
}
