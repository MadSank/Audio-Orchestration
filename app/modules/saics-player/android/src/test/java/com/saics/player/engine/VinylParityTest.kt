package com.saics.player.engine

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin

/**
 * The live Vinyl chain sounds like versions.py (hard rule 5, PLAN P6 parity check).
 * engine/tests/make_vinyl_parity.py renders the Python chain with 12 random seeds and stores
 * the min/max 1/3-octave fingerprint (golden_util.band_fingerprint); this renders the same
 * deterministic input through [Vinyl] and must land inside that envelope +-1 dB.
 */
class VinylParityTest {
  private val envelope: JSONObject by lazy {
    var dir: File? = File("").absoluteFile
    while (dir != null && !File(dir, "engine/tests/golden/vinyl_parity.json").exists()) dir = dir.parentFile
    JSONObject(File(dir!!, "engine/tests/golden/vinyl_parity.json").readText())
  }

  @Test fun vinyl44100() = check(44100)

  @Test fun vinyl48000() = check(48000)

  private fun check(sr: Int) {
    val (l, r) = signal(sr)
    val vl = Vinyl(sr.toDouble(), 11)
    val vr = Vinyl(sr.toDouble(), 23)
    val outL = DoubleArray(l.size) { vl.process(l[it]) }
    val outR = DoubleArray(r.size) { vr.process(r[it]) }
    // versions.py normalises the peak to -1 dB before the fingerprint.
    val peak = maxOf(outL.maxOf { abs(it) }, outR.maxOf { abs(it) })
    val g = 10.0.pow(-1.0 / 20) / peak
    val env = envelope.getJSONObject(sr.toString())
    val tol = env.getDouble("tol_db")
    val misses = mutableListOf<String>()
    var compared = 0
    listOf(outL, outR).forEachIndexed { ch, y ->
      val fp = fingerprint(DoubleArray(y.size) { y[it] * g }, sr)
      val lo = env.getJSONArray("min").getJSONArray(ch)
      val hi = env.getJSONArray("max").getJSONArray(ch)
      for (f in fp.indices) for (b in fp[f].indices) {
        val mn = (lo.getJSONArray(f) as JSONArray).getDouble(b)
        val mx = (hi.getJSONArray(f) as JSONArray).getDouble(b)
        if (mx < -80) continue // near-silent in the reference: numerically meaningless
        compared++
        val v = fp[f][b]
        if (v < mn - tol || v > mx + tol) misses.add("ch$ch frame $f band $b: %.2f not in [%.2f, %.2f]".format(v, mn, mx))
      }
    }
    // Pops are random: the Python chain itself misses this envelope sometimes (max_miss_rate,
    // measured on fresh seeds by make_vinyl_parity.py). The port may miss no more often.
    val allowed = env.getDouble("max_miss_rate")
    val rate = misses.size.toDouble() / compared
    assertTrue("miss rate %.3f > Python's %.3f:\n".format(rate, allowed) + misses.take(20).joinToString("\n"), rate <= allowed)
  }

  /** golden_util test signal without the random noise burst: L = log sweep, R = 120 BPM clicks. */
  private fun signal(sr: Int): Pair<DoubleArray, DoubleArray> {
    val n = (10.0 * sr).toInt()
    val f0 = 50.0
    val f1 = 12000.0
    val k = ln(f1 / f0) / 10.0
    val left = DoubleArray(n) { val t = it.toDouble() / sr; (0.4 * sin(2 * PI * f0 * (exp(k * t) - 1) / k)).toFloat().toDouble() }
    val right = DoubleArray(n)
    val len = (0.004 * sr).toInt()
    val click = DoubleArray(len) { 0.5 - 0.5 * cos(2 * PI * it / (len - 1)) } // np.hanning
    var start = 0
    while (start < n - len) {
      for (i in 0 until len) right[start + i] += 0.8 * click[i]
      start += (0.5 * sr).toInt()
    }
    for (i in 0 until n) right[i] = right[i].toFloat().toDouble()
    return left to right
  }

  /** golden_util.band_fingerprint: per 1 s frame, dB energy in 1/3-octave bands 25 Hz-16 kHz. */
  private fun fingerprint(y: DoubleArray, sr: Int): List<DoubleArray> {
    val centres = DoubleArray(29) { 1000.0 * 2.0.pow((it - 16) / 3.0) }
    val frame = sr
    val win = DoubleArray(frame) { 0.5 - 0.5 * cos(2 * PI * it / (frame - 1)) }
    val out = mutableListOf<DoubleArray>()
    var s = 0
    while (s + frame <= y.size) {
      val re = DoubleArray(frame) { y[s + it] * win[it] }
      val im = DoubleArray(frame)
      fft(re, im)
      out.add(DoubleArray(centres.size) { b ->
        val lo = centres[b] * 2.0.pow(-1.0 / 6)
        val hi = centres[b] * 2.0.pow(1.0 / 6)
        var e = 0.0
        for (bin in 0..frame / 2) {
          val f = bin.toDouble() * sr / frame
          if (f >= lo && f < hi) e += re[bin] * re[bin] + im[bin] * im[bin]
        }
        10 * log10(e + 1e-12)
      })
      s += frame
    }
    return out
  }

  /** In-place mixed-radix FFT (any length whose prime factors are small, e.g. 44100, 48000). */
  private fun fft(re: DoubleArray, im: DoubleArray) {
    val n = re.size
    if (n == 1) return
    val p = (2..n).first { n % it == 0 }
    val m = n / p
    val subRe = Array(p) { r -> DoubleArray(m) { re[it * p + r] } }
    val subIm = Array(p) { r -> DoubleArray(m) { im[it * p + r] } }
    for (r in 0 until p) fft(subRe[r], subIm[r])
    for (k in 0 until n) {
      var sr = 0.0
      var si = 0.0
      for (r in 0 until p) {
        val a = -2 * PI * r * k / n
        val c = cos(a)
        val sn = sin(a)
        val xr = subRe[r][k % m]
        val xi = subIm[r][k % m]
        sr += xr * c - xi * sn
        si += xr * sn + xi * c
      }
      re[k] = sr
      im[k] = si
    }
  }
}
