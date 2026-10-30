package com.saics.player.engine

import org.json.JSONObject

/** The parts of a `saics.analysis/9` bundle the engine plays from (engine/saics/schema.py). */
class Bundle(
  val beats: DoubleArray,
  val downbeats: IntArray,
  val sections: List<Section>,
  val jumps: List<Jump>,
  val outroBar: Int?,
  val loopable: Boolean,
  val gainDb: Double,
) {
  class Section(val startBar: Int, val endBar: Int, val group: Int)
  class Jump(val fromBar: Int, val toBar: Int, val score: Double, val kind: String, val label: String)

  /** Bar start times (s); the last bar runs to the end of the audio, as render.py `_bar_times`. */
  fun barTimes(audioSeconds: Double): DoubleArray {
    val n = downbeats.size - 1
    if (n < 1) return doubleArrayOf(0.0, audioSeconds)
    val t = DoubleArray(n + 1) { beats[downbeats[it]] }
    t[n] = maxOf(audioSeconds, t[n - 1] + 0.01)
    return t
  }

  companion object {
    const val SCHEMA = "saics.analysis/9"

    /** Null when the bundle is missing, unreadable or an older schema (plain playback). */
    fun parse(text: String): Bundle? = try {
      val o = JSONObject(text)
      if (o.optString("schema") != SCHEMA) {
        null
      } else {
        val beats = o.getJSONArray("beats").let { a -> DoubleArray(a.length()) { a.getDouble(it) } }
        val down = o.getJSONArray("downbeats").let { a -> IntArray(a.length()) { a.getInt(it) } }
        val secs = o.getJSONArray("sections").let { a ->
          (0 until a.length()).map { a.getJSONObject(it) }
            .map { Section(it.getInt("start_bar"), it.getInt("end_bar"), it.getInt("group")) }
        }
        val jumps = o.optJSONArray("jumps")?.let { a ->
          (0 until a.length()).map { a.getJSONObject(it) }.map {
            Jump(it.getInt("from_bar"), it.getInt("to_bar"), it.getDouble("score"), it.getString("kind"), it.getString("label"))
          }
        } ?: emptyList()
        val outro = if (o.isNull("outro_bar")) null else o.optInt("outro_bar", 0).takeIf { it > 0 }
        Bundle(
          beats, down, secs, jumps, outro, o.optBoolean("loopable", true),
          o.optJSONObject("loudness")?.optDouble("gain_db", 0.0) ?: 0.0,
        )
      }
    } catch (e: Exception) {
      null
    }
  }
}
