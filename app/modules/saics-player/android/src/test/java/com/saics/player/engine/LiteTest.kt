package com.saics.player.engine

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.sin

/** The port against engine/saics/lite.py: engine/tests/make_lite_golden.py wrote these values. */
class LiteTest {
  private val golden: JSONObject by lazy {
    var dir: File? = File("").absoluteFile
    while (dir != null && !File(dir, "engine/tests/golden/lite.json").exists()) dir = dir.parentFile
    JSONObject(File(dir!!, "engine/tests/golden/lite.json").readText())
  }

  private val y44: FloatArray by lazy {
    val plan = golden.getString("plan")
    val root = mapOf('I' to 110.0, 'A' to 220.0, 'B' to 277.18, 'C' to 174.61, 'D' to 311.13, 'O' to 146.83)
    val n = (4 * plan.length * 4 * 0.5 * 44100).toInt()
    val totalBeats = n / 22050
    FloatArray(n) { i ->
      val t = i / 44100.0
      val beat = floor(t / 0.5).toInt()
      val letter = plan[minOf(minOf(beat, totalBeats - 1) / 16, plan.length - 1)]
      val f = root.getValue(letter)
      val step = (beat % 4) * 0.25
      val phase = t - beat * 0.5
      val click = exp(-phase * 30.0) * sin(2 * PI * 1800.0 * phase)
      (0.3 * sin(2 * PI * f * (1 + step) * t) + 0.15 * sin(2 * PI * f * 1.5 * t) + 0.2 * click * (if (beat % 4 == 0) 2.0 else 1.0)).toFloat()
    }
  }
  private val y22: FloatArray by lazy { Lite.halve(y44) }
  private val beats: DoubleArray by lazy { DoubleArray(y44.size / 22050) { it * 0.5 } }

  private fun doubles(a: JSONArray) = DoubleArray(a.length()) { a.getDouble(it) }
  private fun ints(a: JSONArray) = IntArray(a.length()) { a.getInt(it) }

  @Test fun halving() {
    assertEquals(golden.getInt("y22_len"), y22.size)
    val at = golden.getJSONObject("y22_at")
    for (k in at.keys()) assertEquals(at.getDouble(k), y22[k.toInt()].toDouble(), 2e-5)
  }

  @Test fun logMelMatches() {
    val spect = Lite.logMel(y22)
    assertEquals(golden.getInt("mel_frames"), spect.size / Lite.N_MELS)
    val mel = golden.getJSONObject("mel")
    for (k in mel.keys()) {
      val row = doubles(mel.getJSONArray(k))
      val got = DoubleArray(Lite.N_MELS) { spect[k.toInt() * Lite.N_MELS + it].toDouble() }
      assertArrayEquals(row, got, 2e-3)
    }
  }

  @Test fun chunks() {
    assertArrayEquals(ints(golden.getJSONArray("chunk_starts")), Lite.chunkStarts(4000))
    assertArrayEquals(ints(golden.getJSONArray("chunk_starts_short")), Lite.chunkStarts(800))
  }

  @Test fun chunksCoverEveryFrameWithTheEarlierChunkWinning() {
    val n = 4000
    val (b, _) = Lite.framesToLogits(FloatArray(n * Lite.N_MELS)) { _, t -> FloatArray(t) { 1f } to FloatArray(t) }
    assertEquals(0, b.count { it != 1.0 })
  }

  @Test fun peaks() {
    val logits = doubleArrayOf(-2.0, -1.0, 3.0, -1.0, -5.0, 1.0, 2.0, 2.0, 1.0, -3.0, -3.0, -3.0, 0.5, -1.0, -1.0, -1.0, -1.0, 4.0)
    assertArrayEquals(doubles(golden.getJSONArray("peaks")), Lite.peaks(logits), 1e-9)
  }

  @Test fun beatFeatures() {
    val f = Lite.beatFeatures(y22, beats)
    for (k in golden.getJSONObject("chroma_b").keys()) {
      assertArrayEquals(doubles(golden.getJSONObject("chroma_b").getJSONArray(k)), f.chroma[k.toInt()], 2e-3)
      assertArrayEquals(doubles(golden.getJSONObject("mfcc_b").getJSONArray(k)), f.mfcc[k.toInt()], 0.05)
      assertEquals(golden.getJSONObject("onset_b").getDouble(k), f.onset[k.toInt()], 2e-3)
      assertEquals(golden.getJSONObject("rms_b").getDouble(k), f.rms[k.toInt()], 2e-4)
    }
  }

  @Test fun theWholeAnalysis() {
    val raw = IntArray((beats.size + 3) / 4) { it * 4 }
    val r = Lite.analyse(y22, y44.size / 44100.0, beats, raw)
    assertArrayEquals(ints(golden.getJSONArray("downbeats")), r.downbeats)
    val secs = golden.getJSONArray("sections")
    assertEquals(secs.toString(), JSONArray(r.sections.map { JSONArray(listOf(it.startBar, it.endBar, it.group)) }).toString())
    val jumps = golden.getJSONArray("jumps")
    assertEquals(jumps.length(), r.jumps.size)
    for (i in 0 until jumps.length()) {
      val j = jumps.getJSONArray(i)
      assertEquals(j.getInt(0), r.jumps[i].fromBar)
      assertEquals(j.getInt(1), r.jumps[i].toBar)
      assertEquals(j.getDouble(2), r.jumps[i].score, 1e-3)
      assertEquals(j.getString(4), r.jumps[i].label)
    }
    assertEquals(golden.getInt("outro_bar"), r.outroBar)
  }

  @Test fun regularizedBarGrid() {
    val g = golden.getJSONObject("regularize")
    val out = Lite.regularizeDownbeats(ints(g.getJSONArray("raw")), 46, DoubleArray(46) { 1.0 })
    assertArrayEquals(ints(g.getJSONArray("out")), out)
  }

  @Test fun loudness() {
    val l = Lite.integratedLufs(y44.size, { y44[it] }, { y44[it] })
    assertEquals(golden.getDouble("lufs"), l, 0.01)
  }

  @Test fun bundleJsonParses() {
    val r = Lite.Result(
      DoubleArray(9) { it * 0.5 }, intArrayOf(0, 4, 8), listOf(Bundle.Section(0, 2, 0)),
      listOf(Bundle.Jump(1, 0, 0.8, "repeat", "A1:2 → A1:1")), 2,
    )
    val b = Bundle.parse(Lite.toJson(r, -10.0, 4.5))!!
    assertEquals(-4.0, b.gainDb, 1e-9)
    assertEquals(1, b.jumps.size)
    assertEquals(120.0, b.bpm, 1e-9)
    assertArrayEquals(intArrayOf(0, 4, 8), b.downbeats)
  }
}
