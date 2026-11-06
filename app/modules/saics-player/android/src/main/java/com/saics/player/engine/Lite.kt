package com.saics.player.engine

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sign
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Forever analysis on the phone: the port of engine/saics/lite.py, plus the parts of jumps.py and
 * structure.py it uses, compared value by value with engine/tests/golden/lite.json (LiteTest).
 * Pure functions on arrays, off the audio path: never call these from the render thread.
 */
object Lite {
  const val BEAT_SR = 22050
  const val BEAT_FPS = 50
  const val N_MELS = 128
  const val CHUNK = 1500
  const val BORDER = 6
  private const val BEAT_FFT = 1024
  private const val BEAT_HOP = 441
  private const val FEAT_FFT = 4096
  private const val FEAT_HOP = 512
  private const val N_MFCC = 14
  private const val N_FEATS = 12 + 13 + 2

  // jumps.py
  private const val CONTEXT_BARS = 4
  private const val MIN_JUMP_BARS = 16
  private const val PREFERRED_JUMP_S = 30.0
  private const val CTX_MIN = 0.20
  private const val STRONG_STRIPE = 0.70
  private const val LITE_CTX_MEAN = 0.62
  private const val PER_SECONDS = 20.0
  private const val ALIGN_BARS = 4
  private const val ALIGN_MARGIN = 0.04
  private const val SLOTS = 4

  /** 44.1 kHz -> 22.05 kHz, as lite.halve (np.convolve "same", then every second sample). */
  fun halve(y: FloatArray, length: Int = y.size): FloatArray {
    val taps = 63
    val h = DoubleArray(taps) {
      val n = it - (taps - 1) / 2.0
      val x = PI * n * 0.45
      (if (n == 0.0) 1.0 else sin(x) / x) * 0.45 * (0.5 + 0.5 * cos(2 * PI * n / (taps - 1)))
    }
    val total = h.sum()
    for (i in h.indices) h[i] /= total
    val half = (taps - 1) / 2
    return FloatArray((length + 1) / 2) { out ->
      val c = out * 2
      var acc = 0.0
      for (k in 0 until taps) {
        val j = c - half + k
        if (j in 0 until length) acc += y[j] * h[taps - 1 - k]
      }
      acc.toFloat()
    }
  }

  private class Fft(val n: Int) {
    private val cosT = DoubleArray(n / 2) { cos(2 * PI * it / n) }
    private val sinT = DoubleArray(n / 2) { sin(2 * PI * it / n) }
    private val rev = IntArray(n).also { r ->
      val bits = Integer.numberOfTrailingZeros(n)
      for (i in 0 until n) r[i] = Integer.reverse(i) ushr (32 - bits)
    }
    private val re = DoubleArray(n)
    private val im = DoubleArray(n)

    /** |X[k]| of a real frame, k = 0..n/2. */
    fun magnitude(x: DoubleArray, out: DoubleArray) {
      for (i in 0 until n) {
        re[i] = x[rev[i]]
        im[i] = 0.0
      }
      var size = 2
      while (size <= n) {
        val h = size / 2
        val step = n / size
        var i = 0
        while (i < n) {
          for (j in 0 until h) {
            val c = cosT[j * step]
            val s = -sinT[j * step]
            val a = i + j
            val b = a + h
            val tr = re[b] * c - im[b] * s
            val ti = re[b] * s + im[b] * c
            re[b] = re[a] - tr
            im[b] = im[a] - ti
            re[a] += tr
            im[a] += ti
          }
          i += size
        }
        size *= 2
      }
      for (k in 0..n / 2) out[k] = sqrt(re[k] * re[k] + im[k] * im[k])
    }
  }

  /** Calls [frame] with each centred, reflect-padded, Hann-windowed frame's magnitudes. */
  private fun stft(y: FloatArray, nFft: Int, hop: Int, frame: (Int, DoubleArray) -> Unit): Int {
    val pad = nFft / 2
    val total = y.size + 2 * pad
    val frames = 1 + (total - nFft) / hop
    val win = DoubleArray(nFft) { 0.5 - 0.5 * cos(2 * PI * it / nFft) }
    val fft = Fft(nFft)
    val x = DoubleArray(nFft)
    val mag = DoubleArray(nFft / 2 + 1)
    val last = y.size - 1
    for (f in 0 until frames) {
      val start = f * hop - pad
      for (i in 0 until nFft) {
        var j = start + i
        // reflect without repeating the edge, np.pad's mode="reflect"
        if (j < 0) j = -j
        if (j > last) j = 2 * last - j
        x[i] = if (j in 0..last) y[j].toDouble() * win[i] else 0.0
      }
      fft.magnitude(x, mag)
      frame(f, mag)
    }
    return frames
  }

  private fun hzToMel(f: Double) = if (f < 1000) 3 * f / 200 else 15 + 27 * ln(max(f, 1e-9) / 1000) / ln(6.4)
  private fun melToHz(m: Double) = if (m < 15) 200 * m / 3 else 1000 * 6.4.pow((m - 15) / 27)

  /** Sparse triangles: for each mel band, first bin and weights (torchaudio's norm=None). */
  private class MelBank(nFft: Int, sr: Int, nMels: Int, fMin: Double, fMax: Double) {
    val first = IntArray(nMels)
    val weights = arrayOfNulls<DoubleArray>(nMels)

    init {
      val bins = nFft / 2 + 1
      val lo = hzToMel(fMin)
      val hi = hzToMel(fMax)
      val pts = DoubleArray(nMels + 2) { melToHz(lo + (hi - lo) * it / (nMels + 1)) }
      for (m in 0 until nMels) {
        val w = DoubleArray(bins) { k ->
          val f = k * sr.toDouble() / nFft
          max(0.0, min((f - pts[m]) / (pts[m + 1] - pts[m]), (pts[m + 2] - f) / (pts[m + 2] - pts[m + 1])))
        }
        val a = w.indexOfFirst { it > 0 }.coerceAtLeast(0)
        val b = w.indexOfLast { it > 0 }.coerceAtLeast(a)
        first[m] = a
        weights[m] = w.copyOfRange(a, b + 1)
      }
    }

    fun apply(spec: DoubleArray, m: Int): Double {
      val w = weights[m]!!
      val a = first[m]
      var acc = 0.0
      for (i in w.indices) acc += spec[a + i] * w[i]
      return acc
    }
  }

  /** Beat This!'s input: rows of 128 values, flattened. */
  fun logMel(y22: FloatArray): FloatArray {
    val bank = MelBank(BEAT_FFT, BEAT_SR, N_MELS, 30.0, 11000.0)
    val pad = BEAT_FFT / 2
    val frames = 1 + (y22.size + 2 * pad - BEAT_FFT) / BEAT_HOP
    val out = FloatArray(frames * N_MELS)
    val norm = 1.0 / sqrt(BEAT_FFT.toDouble())
    val spec = DoubleArray(BEAT_FFT / 2 + 1)
    stft(y22, BEAT_FFT, BEAT_HOP) { f, mag ->
      for (k in spec.indices) spec[k] = mag[k] * norm
      for (m in 0 until N_MELS) out[f * N_MELS + m] = ln(1.0 + 1000 * bank.apply(spec, m)).toFloat()
    }
    return out
  }

  fun chunkStarts(frames: Int): IntArray {
    val out = ArrayList<Int>()
    var s = -BORDER
    while (s < frames - BORDER) {
      out.add(s)
      s += CHUNK - 2 * BORDER
    }
    if (frames > CHUNK - 2 * BORDER) out[out.size - 1] = frames - (CHUNK - BORDER)
    return out.toIntArray()
  }

  /** The model over a whole song. [run] takes (T x 128 flattened, T), returns (beat, downbeat)
   *  logits of length T. Overlaps keep the earlier chunk's prediction, as lite.frames_to_logits. */
  fun framesToLogits(spect: FloatArray, run: (FloatArray, Int) -> Pair<FloatArray, FloatArray>): Pair<DoubleArray, DoubleArray> {
    val n = spect.size / N_MELS
    val beat = DoubleArray(n) { -1000.0 }
    val down = DoubleArray(n) { -1000.0 }
    val starts = chunkStarts(n)
    for (si in starts.indices.reversed()) {
      val start = starts[si]
      val a = max(start, 0)
      val b = min(start + CHUNK, n)
      val left = max(0, -start)
      val right = max(0, min(BORDER, start + CHUNK - n))
      val t = left + (b - a) + right
      val x = FloatArray(t * N_MELS)
      System.arraycopy(spect, a * N_MELS, x, left * N_MELS, (b - a) * N_MELS)
      val (lb, ld) = run(x, t)
      val lo = start + BORDER
      for (i in 0 until t - 2 * BORDER) {
        val at = lo + i
        if (at in 0 until n) {
          beat[at] = lb[BORDER + i].toDouble()
          down[at] = ld[BORDER + i].toDouble()
        }
      }
    }
    return beat to down
  }

  fun peaks(logits: DoubleArray): DoubleArray {
    val out = ArrayList<Double>()
    var sum = 0.0
    var count = 0
    var prev = -10
    for (i in logits.indices) {
      if (logits[i] <= 0) continue
      var top = logits[i]
      for (j in max(0, i - 3)..min(logits.size - 1, i + 3)) top = max(top, logits[j])
      if (logits[i] != top) continue
      if (count > 0 && i - prev > 1) {
        out.add(sum / count)
        sum = 0.0
        count = 0
      }
      sum += i
      count++
      prev = i
    }
    if (count > 0) out.add(sum / count)
    return out.toDoubleArray()
  }

  /** (beat times, indices of the beats that are downbeats). */
  fun beatsFromLogits(beat: DoubleArray, down: DoubleArray): Pair<DoubleArray, IntArray> {
    val b = peaks(beat).map { it / BEAT_FPS }.toDoubleArray()
    val d = peaks(down).map { it / BEAT_FPS }
    if (b.isEmpty()) return b to IntArray(0)
    val idx = d.map { t ->
      var best = 0
      for (i in b.indices) if (abs(b[i] - t) < abs(b[best] - t)) best = i
      best
    }.toSortedSet()
    return b to idx.toIntArray()
  }

  // ── features ──────────────────────────────────────────────────────────────

  class BeatFeatures(val chroma: Array<DoubleArray>, val mfcc: Array<DoubleArray>, val onset: DoubleArray, val rms: DoubleArray)

  /** chroma[beat][12], mfcc[beat][13], onset[beat], rms[beat]. */
  fun beatFeatures(y22: FloatArray, beats: DoubleArray): BeatFeatures {
    val bins = FEAT_FFT / 2 + 1
    val pitch = IntArray(bins) { k ->
      val f = k * BEAT_SR.toDouble() / FEAT_FFT
      if (f < 55 || f > 5000) -1 else Math.floorMod(Math.rint(12 * ln(f / 440.0) / ln(2.0) + 9).toInt(), 12)
    }
    val bank = MelBank(FEAT_FFT, BEAT_SR, N_MELS, 0.0, BEAT_SR / 2.0)
    val dct = Array(N_MFCC) { k ->
      DoubleArray(N_MELS) { i ->
        cos(PI * k * (2 * i + 1) / (2 * N_MELS)) * sqrt(2.0 / N_MELS) * (if (k == 0) 1 / sqrt(2.0) else 1.0)
      }
    }
    val pad = FEAT_FFT / 2
    val frames = 1 + (y22.size + 2 * pad - FEAT_FFT) / FEAT_HOP
    val data = FloatArray(frames * N_FEATS)
    val power = DoubleArray(bins)
    val logmel = DoubleArray(N_MELS)
    val prev = DoubleArray(N_MELS)
    val chroma = DoubleArray(12)
    stft(y22, FEAT_FFT, FEAT_HOP) { f, mag ->
      var total = 0.0
      chroma.fill(0.0)
      for (k in 0 until bins) {
        val p = mag[k] * mag[k]
        power[k] = p
        total += p
        if (pitch[k] >= 0) chroma[pitch[k]] += p
      }
      val top = chroma.max() + 1e-9
      val o = f * N_FEATS
      for (c in 0 until 12) data[o + c] = (chroma[c] / top).toFloat()
      var flux = 0.0
      for (m in 0 until N_MELS) {
        logmel[m] = 10 * log10(max(bank.apply(power, m), 1e-10))
        if (f > 0) flux += max(0.0, logmel[m] - prev[m])
        prev[m] = logmel[m]
      }
      for (c in 1 until N_MFCC) {
        var acc = 0.0
        for (m in 0 until N_MELS) acc += logmel[m] * dct[c][m]
        data[o + 11 + c] = acc.toFloat()
      }
      data[o + 25] = (flux / N_MELS).toFloat()
      data[o + 26] = (sqrt(total) / FEAT_FFT).toFloat()
    }
    val nb = beats.size
    val edges = IntArray(nb + 1) { i ->
      if (i == nb) frames else Math.rint(beats[i] * BEAT_SR / FEAT_HOP).toInt().coerceIn(0, frames)
    }
    val mean = Array(nb) { i ->
      val out = DoubleArray(N_FEATS)
      val a = edges[i]
      val b = edges[i + 1]
      if (b > a) {
        for (f in a until b) for (d in 0 until N_FEATS) out[d] += data[f * N_FEATS + d].toDouble()
        for (d in 0 until N_FEATS) out[d] /= (b - a).toDouble()
      }
      out
    }
    return BeatFeatures(
      Array(nb) { mean[it].copyOfRange(0, 12) }, Array(nb) { mean[it].copyOfRange(12, 25) },
      DoubleArray(nb) { mean[it][25] }, DoubleArray(nb) { mean[it][26] },
    )
  }

  /** BS.1770 integrated loudness at 44.1 kHz (lite.integrated_lufs). */
  fun integratedLufs(frames: Int, left: (Int) -> Float, right: (Int) -> Float): Double {
    val power = DoubleArray(frames)
    for (ch in 0..1) {
      val src = if (ch == 0) left else right
      var x1 = 0.0; var x2 = 0.0; var y1 = 0.0; var y2 = 0.0
      var u1 = 0.0; var u2 = 0.0; var v1 = 0.0; var v2 = 0.0
      for (i in 0 until frames) {
        val x = src(i).toDouble()
        val y = 1.53084 * x - 2.65010 * x1 + 1.16927 * x2 + 1.66365 * y1 - 0.71265 * y2
        x2 = x1; x1 = x; y2 = y1; y1 = y
        val v = y - 2.0 * u1 + u2 + 1.98916 * v1 - 0.98919 * v2
        u2 = u1; u1 = y; v2 = v1; v1 = v
        power[i] += v * v
      }
    }
    val win = (0.4 * 44100).toInt()
    val hop = (0.1 * 44100).toInt()
    if (frames < win) return -70.0
    val cum = DoubleArray(frames + 1)
    for (i in 0 until frames) cum[i + 1] = cum[i] + power[i]
    val blocks = ArrayList<Double>()
    var s = 0
    while (s + win <= frames) {
      blocks.add((cum[s + win] - cum[s]) / win)
      s += hop
    }
    fun loud(b: Double) = -0.691 + 10 * log10(b + 1e-12)
    val keep = blocks.filter { loud(it) > -70.0 }
    if (keep.isEmpty()) return -70.0
    val rel = -0.691 + 10 * log10(keep.average()) - 10.0
    val kept = blocks.filter { loud(it) > max(rel, -70.0) }
    return if (kept.isEmpty()) -70.0 else -0.691 + 10 * log10(kept.average())
  }

  // ── structure.py ──────────────────────────────────────────────────────────

  private fun votes(raw: Set<Int>, lo: Int, hi: Int, m: Int, strength: DoubleArray): DoubleArray {
    val v = DoubleArray(m)
    for (i in max(lo, 0) until min(hi, strength.size)) {
      if (i in raw) v[i % m] += 1.0
      v[i % m] += 0.01 * strength[i]
    }
    return v
  }

  private fun argmax(x: DoubleArray): Int {
    var b = 0
    for (i in x.indices) if (x[i] > x[b]) b = i
    return b
  }

  /** Never assumes 4/4: raw downbeats when consistent, else a tracked 4- (or clearly 3-) beat grid. */
  fun regularizeDownbeats(raw: IntArray, nBeats: Int, strength: DoubleArray): IntArray {
    if (raw.size >= 3) {
      val counts = HashMap<Int, Int>()
      for (i in 1 until raw.size) counts.merge(raw[i] - raw[i - 1], 1, Int::plus)
      val gaps = raw.size - 1
      val best = counts.entries.sortedWith(compareBy({ -it.value }, { it.key })).first()
      if (best.value.toDouble() / gaps >= 0.9 && best.key in 3..7) return raw
    }
    if (nBeats == 0) return IntArray(0)
    val set = raw.toSet()
    fun agree(m: Int): Double = if (raw.isEmpty()) 0.0 else (0 until m).maxOf { ph -> raw.count { Math.floorMod(it - ph, m) == 0 }.toDouble() / raw.size }
    val m = if (agree(3) > agree(4) + 0.15) 3 else 4
    val window = 8 * m
    var pos = argmax(votes(set, 0, window, m, strength))
    val grid = arrayListOf(pos)
    while (true) {
      var nxt = pos + m
      if (nxt >= nBeats) break
      val v = votes(set, nxt, nxt + window, m, strength)
      val best = argmax(v)
      if (best != nxt % m && v[best] >= v[nxt % m] + 2) {
        val shift = Math.floorMod(best - nxt, m)
        nxt = if (shift <= m / 2) nxt + shift else nxt + shift - m
        nxt = max(nxt, pos + 2)
      }
      grid.add(nxt)
      pos = nxt
    }
    return grid.toIntArray()
  }

  /** Each bar's beats resampled to 4 slots, so that order within the bar counts. */
  private fun barSlots(beatFeats: Array<DoubleArray>, downbeats: IntArray): Array<DoubleArray> {
    val nb = beatFeats.size
    val out = ArrayList<DoubleArray>()
    for (i in 0 until downbeats.size - 1) {
      val a = downbeats[i]
      val b = downbeats[i + 1]
      if (b <= a || b > nb) continue
      val d = beatFeats[a].size
      val row = DoubleArray(SLOTS * d)
      for (s in 0 until SLOTS) {
        val idx = Math.rint(a + (b - 1 - a) * s.toDouble() / (SLOTS - 1)).toInt()
        System.arraycopy(beatFeats[idx], 0, row, s * d, d)
      }
      out.add(row)
    }
    return out.toTypedArray()
  }

  private fun standardize(x: Array<DoubleArray>): Array<DoubleArray> {
    val n = x.size
    val d = x[0].size
    val mean = DoubleArray(d)
    val std = DoubleArray(d)
    for (r in x) for (j in 0 until d) mean[j] += r[j] / n
    for (r in x) for (j in 0 until d) std[j] += (r[j] - mean[j]).pow(2) / n
    return Array(n) { i ->
      val z = DoubleArray(d) { j -> (x[i][j] - mean[j]) / (sqrt(std[j]) + 1e-9) }
      val norm = sqrt(z.sumOf { it * it }) + 1e-9
      for (j in 0 until d) z[j] /= norm
      z
    }
  }

  private fun selfSimilarity(x: Array<DoubleArray>): Array<DoubleArray> {
    val z = standardize(x)
    val n = z.size
    val ssm = Array(n) { DoubleArray(n) }
    for (i in 0 until n) for (j in i until n) {
      var acc = 0.0
      for (k in z[i].indices) acc += z[i][k] * z[j][k]
      ssm[i][j] = acc
      ssm[j][i] = acc
    }
    return ssm
  }

  private fun percentile(values: DoubleArray, q: Double): Double {
    if (values.isEmpty()) return 0.0
    val s = values.sortedArray()
    val p = q / 100 * (s.size - 1)
    val lo = floor(p).toInt()
    val hi = min(lo + 1, s.size - 1)
    return s[lo] + (s[hi] - s[lo]) * (p - lo)
  }

  /** Novelty segmentation; repeat groups by aligned diagonal similarity. */
  fun sectionsFromBars(bars: Array<DoubleArray>, ssm: Array<DoubleArray>, minLen: Int = 4, kernel: Int = 8): List<Bundle.Section> {
    val n = bars.size
    if (n < 2 * minLen) return listOf(Bundle.Section(0, max(1, n), 0))
    val half = min(kernel, n / 2) / 2
    val size = 2 * half
    val sgn = DoubleArray(size) { sign(it - half + 0.5) }
    val taper = DoubleArray(size) { val t = it - half + 0.5; exp(-(t * t) / (2 * (half / 2.0) * (half / 2.0))) }
    val nov = DoubleArray(n) { i ->
      var acc = 0.0
      for (r in 0 until size) for (c in 0 until size) {
        // np.pad(ssm, half, mode="edge") read at (i + r, i + c)
        val a = (i + r - half).coerceIn(0, n - 1)
        val b = (i + c - half).coerceIn(0, n - 1)
        acc += ssm[a][b] * sgn[r] * sgn[c] * taper[r] * taper[c]
      }
      max(acc, 0.0)
    }
    val thr = percentile(nov, 70.0)
    val bounds = arrayListOf(0)
    for (i in nov.indices.sortedByDescending { nov[it] }) {
      if (nov[i] < thr) break
      if (bounds.all { abs(i - it) >= minLen } && n - i >= minLen) bounds.add(i)
    }
    bounds.sort()
    bounds.add(n)
    val segs = (0 until bounds.size - 1).map { bounds[it] to bounds[it + 1] }.filter { it.second > it.first }
    val groups = ArrayList<Int>()
    for (i in segs.indices) {
      val (a, b) = segs[i]
      var g: Int? = null
      for (j in 0 until i) {
        val (c, d) = segs[j]
        val len = min(b - a, d - c)
        if (len < 2) continue
        var acc = 0.0
        for (t in 0 until len) acc += ssm[a + t][c + t]
        if (acc / len >= 0.45 && abs((b - a) - (d - c)) <= max(2, len / 2)) {
          g = groups[j]
          break
        }
      }
      groups.add(g ?: (if (groups.isEmpty()) 0 else groups.max() + 1))
    }
    return segs.indices.map { Bundle.Section(segs[it].first, segs[it].second, groups[it]) }
  }

  // ── jumps.py, without a vocal stem ────────────────────────────────────────

  private fun colCos(x: Array<DoubleArray>, a: Int, b: Int): Double {
    var num = 0.0
    var na = 0.0
    var nb = 0.0
    val u = x[a]
    val v = x[b]
    for (k in u.indices) {
      num += u[k] * v[k]
      na += u[k] * u[k]
      nb += v[k] * v[k]
    }
    return num / (sqrt(na) * sqrt(nb) + 1e-9)
  }

  /** The bar offset that aligns the mix chroma clearly better, else 0. Corrects, never vetoes. */
  private fun bestAlignment(chroma: Array<DoubleArray>, db: IntArray, a: Int, b: Int): Int {
    val gaps = IntArray(max(0, db.size - 1)) { db[it + 1] - db[it] }.sortedArray()
    val bpb = if (gaps.isEmpty()) 4 else if (gaps.size % 2 == 1) gaps[gaps.size / 2] else (gaps[gaps.size / 2 - 1] + gaps[gaps.size / 2]) / 2
    val w = CONTEXT_BARS * bpb
    val nBeats = chroma.size
    if (a >= db.size) return 0
    val aa = db[a]
    if (aa - w < 0 || aa + w > nBeats) return 0
    val s = LinkedHashMap<Int, Double>()
    for (k in -ALIGN_BARS..ALIGN_BARS) {
      val bk = b + k
      if (bk < 0 || bk >= db.size) continue
      val bb = db[bk]
      if (bb - w < 0 || bb + w > nBeats || abs(bb - aa) < MIN_JUMP_BARS * bpb / 2) continue
      var acc = 0.0
      for (t in -w until w) acc += colCos2(chroma, aa + t, bb + t)
      s[k] = acc / (2 * w)
    }
    val zero = s[0] ?: return 0
    var k = 0
    var top = Double.NEGATIVE_INFINITY
    for ((key, v) in s) if (v > top) {
      top = v
      k = key
    }
    if (k == 0 || top - zero < ALIGN_MARGIN) return 0
    val rivals = listOf(-2, -1, 1, 2).mapNotNull { s[k + it] }
    if (rivals.isNotEmpty() && top - rivals.max() < ALIGN_MARGIN / 2) return 0
    return k
  }

  private fun colCos2(chroma: Array<DoubleArray>, a: Int, b: Int) = colCos(chroma, a, b)

  private class Cand(val score: Double, val a: Int, val b: Int)

  fun findJumps(
    bars: Array<DoubleArray>, ssm: Array<DoubleArray>, sections: List<Bundle.Section>, downbeats: IntArray,
    barT: DoubleArray, energy: DoubleArray, chroma: Array<DoubleArray>, duration: Double,
  ): List<Bundle.Jump> {
    val n = bars.size
    if (n < 2 * MIN_JUMP_BARS || sections.isEmpty()) return emptyList()
    val sec = IntArray(n) { -1 }
    sections.forEachIndexed { k, s -> for (b in s.startBar until min(s.endBar, n)) sec[b] = k }
    val count = HashMap<Int, Int>()
    val labels = sections.map { s ->
      val c = count.merge(s.group, 1, Int::plus)!!
      "${(65 + s.group % 26).toChar()}$c"
    }
    val secLen = sections.map { it.endBar - it.startBar }
    fun label(bar: Int): String {
      val k = if (bar in 0 until n) sec[bar] else -1
      return if (k >= 0) "${labels[k]}:${bar - sections[k].startBar + 1}" else "end:$bar"
    }

    val scored = ArrayList<Cand>()
    val seen = HashSet<Long>()
    for (a in CONTEXT_BARS until n - CONTEXT_BARS) {
      for (b in CONTEXT_BARS until n - CONTEXT_BARS) {
        val dist = abs(a - b)
        if (dist < MIN_JUMP_BARS || sec[a] == sec[b] || sec[a] < 0 || sec[b] < 0) continue
        if (dist < max(secLen[sec[a]], secLen[sec[b]])) continue
        var sum = 0.0
        var lo = Double.POSITIVE_INFINITY
        for (t in -CONTEXT_BARS until CONTEXT_BARS) {
          val v = ssm[a + t][b + t]
          sum += v
          lo = min(lo, v)
        }
        val m = sum / (2 * CONTEXT_BARS)
        val same = sections[sec[a]].group == sections[sec[b]].group
        if (lo < CTX_MIN || m < (if (same) LITE_CTX_MEAN else max(LITE_CTX_MEAN, STRONG_STRIPE))) continue
        // Candidates are taken in this same order by jumps.py: a target moved onto an earlier
        // pair's is dropped, so the order matters.
        val b2 = b + bestAlignment(chroma, downbeats, a, b)
        val key = a.toLong() shl 32 or (b2.toLong() and 0xffffffffL)
        if (key in seen || b2 !in 0 until n || abs(a - b2) < MIN_JUMP_BARS || sec[b2] == sec[a]) continue
        seen.add(key)
        val distS = abs(barT[b2] - barT[a])
        val step = abs(energy[a] - energy[b2])
        val score = 0.45 * m + 0.15 * lo + 0.2 + 0.1 * min(1.0, distS / PREFERRED_JUMP_S) + 0.1 * (1 - min(1.0, 3 * step))
        scored.add(Cand(score, a, b2))
      }
    }
    val order = compareBy<Cand>({ -it.score }, { -it.a }, { -it.b })
    val best = LinkedHashMap<Int, Cand>()
    for (c in scored.sortedWith(order)) best.putIfAbsent(c.a, c)
    val keep = max(2, (duration / PER_SECONDS).toInt())
    val chosen = ArrayList<Cand>()
    for (c in best.values.sortedWith(order)) {
      if (chosen.any { abs(c.a - it.a) < 4 }) continue
      chosen.add(c)
      if (chosen.size >= keep) break
    }
    return chosen.sortedBy { it.a }.map { Bundle.Jump(it.a, it.b, it.score, "repeat", "${label(it.a)} → ${label(it.b)}") }
  }

  private fun outroBar(sections: List<Bundle.Section>, nBars: Int): Int {
    if (sections.size >= 3) {
      val last = sections.last()
      if (sections.count { it.group == last.group } == 1) return last.startBar
    }
    return nBars
  }

  class Result(val beats: DoubleArray, val downbeats: IntArray, val sections: List<Bundle.Section>, val jumps: List<Bundle.Jump>, val outroBar: Int)

  /** Bundle fields from audio and a beat list (lite.analyse). */
  fun analyse(y22: FloatArray, duration: Double, beats: DoubleArray, rawDown: IntArray): Result {
    if (beats.size < 8) return Result(beats, IntArray(0), emptyList(), emptyList(), 0)
    val f = beatFeatures(y22, beats)
    val downbeats = regularizeDownbeats(rawDown, beats.size, f.onset)
    val top = f.onset.max() + 1e-9
    val beatFeats = Array(beats.size) { i ->
      DoubleArray(26) { d ->
        when {
          d < 12 -> f.chroma[i][d]
          d < 25 -> f.mfcc[i][d - 12] / 10.0
          else -> f.onset[i] / top
        }
      }
    }
    val bars = barSlots(beatFeats, downbeats)
    val n = bars.size
    if (n == 0) return Result(beats, downbeats, emptyList(), emptyList(), 0)
    val ssm = selfSimilarity(bars)
    val sections = sectionsFromBars(bars, ssm)
    val barRms = DoubleArray(n) { i ->
      val a = downbeats[i]
      val b = downbeats[i + 1]
      var acc = 0.0
      for (t in a until b) acc += f.rms[t]
      acc / max(1, b - a)
    }
    val ref = percentile(barRms, 95.0)
    val energy = DoubleArray(n) { (barRms[it] / (ref + 1e-9)).coerceIn(0.0, 1.0) }
    val barT = DoubleArray(n + 1) { i -> if (i < downbeats.size) beats[downbeats[i]] else duration }
    val jumps = findJumps(bars, ssm, sections, downbeats, barT, energy, f.chroma, duration)
    return Result(beats, downbeats, sections, jumps, outroBar(sections, n))
  }

  /** As a `saics.analysis/9` bundle, with only the fields [Bundle.parse] reads. */
  fun toJson(r: Result, lufs: Double, duration: Double): String {
    val ibi = (1 until r.beats.size).map { r.beats[it] - r.beats[it - 1] }.sorted()
    val bpm = if (ibi.isEmpty()) 0.0 else 60.0 / ibi[ibi.size / 2]
    return JSONObject()
      .put("schema", Bundle.SCHEMA)
      .put("source", "phone")
      .put("duration_s", duration)
      .put("beats", JSONArray(r.beats.map { Math.round(it * 10000) / 10000.0 }))
      .put("downbeats", JSONArray(r.downbeats.toList()))
      .put("sections", JSONArray(r.sections.map { JSONObject().put("start_bar", it.startBar).put("end_bar", it.endBar).put("group", it.group) }))
      .put("jumps", JSONArray(r.jumps.map { JSONObject().put("from_bar", it.fromBar).put("to_bar", it.toBar).put("score", it.score).put("kind", it.kind).put("label", it.label) }))
      .put("outro_bar", r.outroBar)
      .put("loopable", true)
      .put("loudness", JSONObject().put("integrated_lufs", lufs).put("gain_db", -14.0 - lufs))
      .put("tempo", JSONObject().put("bpm", bpm))
      .toString()
  }
}
