package com.saics.player.engine

import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.random.Random

/** `.saics/portals.json` (engine/saics/schema.py PortalGraph): the Mix Web, computed on the PC. */
class PortalGraph(val tracks: Map<String, Track>) {
  class Edge(
    val fromBar: Int, val to: String, val toBar: Int, val score: Double,
    val pair: String, val sameGroup: Boolean, val offsetMs: Double = 0.0,
  )
  class Track(
    val id: String, val group: String, val bpm: Double, val camelot: String, val sections: List<String>,
    val bars: Int, val entries: List<Int>, val breakExits: Set<Int>, val portals: List<Edge>,
    val levelOut: DoubleArray = DoubleArray(0), val levelIn: DoubleArray = DoubleArray(0), val walkable: Boolean = true,
  ) {
    /** Portals out of this song to other song groups. */
    val exits = portals.count { !it.sameGroup }
    val key get() = group.ifEmpty { id }
  }

  companion object {
    const val SCHEMA = "saics.portals/2"

    /** Null when missing, unreadable or another schema: the app plays without portals. */
    fun parse(text: String): PortalGraph? = try {
      val o = JSONObject(text)
      if (o.optString("schema") != SCHEMA) {
        null
      } else {
        val ts = o.getJSONObject("tracks")
        val out = HashMap<String, Track>()
        for (id in ts.keys()) {
          val t = ts.getJSONObject(id)
          val ps = t.getJSONArray("portals")
          out[id] = Track(
            id, t.optString("group"), t.optDouble("bpm", 0.0), t.optString("camelot"),
            t.getJSONArray("sections").let { a -> List(a.length()) { a.getString(it) } },
            t.optInt("bars"),
            t.getJSONArray("entries").let { a -> List(a.length()) { a.getInt(it) } }.ifEmpty { listOf(0) },
            t.getJSONArray("break_exits").let { a -> (0 until a.length()).map { a.getInt(it) }.toSet() },
            List(ps.length()) {
              val e = ps.getJSONObject(it)
              Edge(e.getInt("from_bar"), e.getString("to"), e.getInt("to_bar"), e.getDouble("score"), e.getString("pair"), e.getBoolean("same_group"), e.optDouble("offset_ms", 0.0))
            },
            t.optJSONArray("level_out")?.let { a -> DoubleArray(a.length()) { a.getDouble(it) } } ?: DoubleArray(0),
            t.optJSONArray("level_in")?.let { a -> DoubleArray(a.length()) { a.getDouble(it) } } ?: DoubleArray(0),
            t.optBoolean("walkable", true),
          )
        }
        PortalGraph(out)
      }
    } catch (e: Exception) {
      null
    }
  }
}

/** Leave this song: at bar [at], continue at [toBar] of track [to]. */
data class Move(
  val kind: String, val to: String, val toBar: Int, val at: Int, val pair: String = "", val score: Double = 0.0,
  val offsetMs: Double = 0.0, // landing shift (portal and back moves)
)

/** engine/saics/seams.py: the portal seam's timing, and the landing trim. */
object Seams {
  /** Before the beat in both songs, so the fade doesn't hold both attacks (round 3c). */
  const val EARLY_MS = -29.0
  /** Off since round 3c: trimmed portals rated worse. The renderer's support for it stays. */
  const val LANDING_TRIM = false
  const val GLIDE_BARS = 4
  const val TRIM_MAX_DB = 6.0
  const val TRIM_DEADBAND_DB = 0.5

  /** Gain on the incoming song at the landing; 0 at the top of a song or without measurements. */
  fun trimDb(levelOut: DoubleArray, exitBar: Int, levelIn: DoubleArray, landBar: Int): Double {
    if (landBar <= 0 || exitBar <= 0 || exitBar >= levelOut.size || landBar >= levelIn.size) return 0.0
    val d = levelOut[exitBar] - levelIn[landBar]
    return if (abs(d) < TRIM_DEADBAND_DB) 0.0 else d.coerceIn(-TRIM_MAX_DB, TRIM_MAX_DB)
  }

  /** How far a move's seam shifts in both songs: only portals, and only into a song's middle. */
  fun earlyMs(kind: String, toBar: Int): Double =
    if ((kind == "portal" || kind == "back") && toBar > 0) EARLY_MS else 0.0
}

/**
 * The Infinite Ride walk over the portal graph: engine/saics/mixwalk.py on the phone (same rules
 * and constants; keep the two in step). One visit at a time: the engine calls [enter] when a song
 * is ready and [step] once per bar, one bar ahead of the audio.
 */
class MixWalk(private val graph: PortalGraph, private val rng: Random = Random(System.nanoTime())) {
  sealed class Decision {
    object Carry : Decision()
    data class Jump(val jump: Bundle.Jump, val why: String) : Decision()
    data class Leave(val move: Move) : Decision()
  }

  var forever = false
  var pool: Set<String>? = null

  private val bad = HashSet<String>()
  private val history = ArrayList<Pair<String, Double>>() // song group, time it was left
  var t = 0.0
    private set
  var cur: PortalGraph.Track? = null
    private set
  var jumpsTaken = 0
    private set
  private var barT = doubleArrayOf(0.0)
  private var sections: List<Bundle.Section> = emptyList()
  private var kinds: List<String> = emptyList()
  private var walk: ForeverWalk? = null
  private var cameFrom: Triple<String, Int, Int>? = null // track, its bar, this landing bar
  private var cameOffsetMs = 0.0
  private var visitT = 0.0
  private var dwell = 60.0
  private var chorusDone = false
  private var chorusFrom = -1
  private var deadSince: Double? = null
  private var holdUntil = 0.0
  private val stays = HashSet<Triple<Int, String, Int>>()
  var fallback: String? = null
    private set

  private val n get() = barT.size - 1

  fun enter(
    track: PortalGraph.Track, times: DoubleArray, secs: List<Bundle.Section>, jumps: List<Bundle.Jump>,
    outro: Int?, loopable: Boolean, bar: Int, came: Triple<String, Int, Int>?, cameOffset: Double = 0.0,
  ) {
    cur = track
    barT = times
    sections = secs
    kinds = track.sections
    cameFrom = came
    cameOffsetMs = cameOffset
    visitT = 0.0
    dwell = DWELL_MIN + (DWELL_MAX - DWELL_MIN) * rng.nextDouble()
    chorusDone = false
    chorusFrom = -1
    deadSince = null
    holdUntil = 0.0
    stays.clear()
    walk = ForeverWalk(times, secs, jumps, outro, loopable, rng.nextLong())
    if (bar > 0) walk?.reset(bar)
    jumpsTaken = 0
    fallback = pickTarget()
  }

  /** Record leaving the current song (at the moment the next one starts). */
  fun left() {
    cur?.let { history.add(it.key to t) }
  }

  /** This song won't play on the phone: never walk into it. */
  fun markBad(id: String) {
    bad.add(id)
    if (fallback == id) fallback = pickTarget()
  }

  private fun allowed(id: String): Boolean {
    val g = graph.tracks[id] ?: return false
    if (id in bad || !g.walkable) return false
    if (pool?.contains(id) == false) return false
    if (g.key == cur?.key) return false
    return history.takeLast(NO_REPEAT_COUNT).none { (k, at) -> k == g.key && t - at < NO_REPEAT_S }
  }

  private fun dwelled(extra: Double = 0.0): Boolean {
    val vt = visitT + extra
    return vt >= dwell || (chorusDone && vt >= MIN_DWELL_S)
  }

  private fun edgeOk(e: PortalGraph.Edge): Boolean {
    if (Triple(e.fromBar, e.to, e.toBar) in stays || e.score < PORTAL_SCORE_MIN) return false
    if (forever) return e.sameGroup && e.to in graph.tracks && e.to !in bad // Forever stays in the song
    return !e.sameGroup && allowed(e.to)
  }

  /** Portal preference: its score, and a song with its own exits beats a dead end. */
  private fun rank(e: PortalGraph.Edge): Double =
    e.score + if ((graph.tracks[e.to]?.exits ?: 0) > 0) EXITS_BONUS else 0.0

  private fun portalsFrom(bar: Int) = cur?.portals.orEmpty().filter { it.fromBar == bar && edgeOk(it) }

  /** The next portal the walk would take after [bar] (shown on Now Playing). */
  fun peek(bar: Int): Move? {
    for (b in maxOf(0, bar + 1) until n) {
      if (!dwelled(barT[b] - barT[maxOf(0, bar)])) continue
      val best = portalsFrom(b).maxByOrNull(::rank) ?: continue
      return Move("portal", best.to, best.toBar, b, best.pair, best.score, best.offsetMs)
    }
    return null
  }

  /** Skip this portal and keep the song. */
  fun stay(m: Move?) {
    if (m != null) stays.add(Triple(m.at, m.to, m.toBar))
    holdUntil = t + STAY_HOLD_S
    deadSince = null
  }

  /** What to play instead of / as [bar] (decided one bar ahead). */
  fun step(bar: Int): Decision {
    if (dwelled()) {
      portalsFrom(bar).maxByOrNull { rank(it) + rng.nextDouble() * 0.02 }?.let {
        return Decision.Leave(Move("portal", it.to, it.toBar, bar, it.pair, it.score, it.offsetMs))
      }
    }
    if (forever) return foreverBar(bar)
    val ahead = cur?.portals.orEmpty().any { edgeOk(it) && it.fromBar > bar }
    if (dwelled() && !ahead && t >= holdUntil) {
      if (deadSince == null) deadSince = t
    } else if (ahead) {
      deadSince = null
    }
    val dead = deadSince
    if (dead != null) {
      fallbackMove(bar, t - dead)?.let { return Decision.Leave(it) }
      return foreverBar(bar)
    }
    if (bar >= n) return Decision.Leave(songEnd(bar))
    trackChorus(bar)
    if (bar >= 0) {
      walk?.plain(bar)
      advance(bar)
    }
    return Decision.Carry
  }

  private fun foreverBar(bar: Int): Decision {
    return when (val r = walk?.step(bar)) {
      null -> Decision.Carry
      ForeverWalk.Step.End -> Decision.Leave(songEnd(bar))
      is ForeverWalk.Step.Play -> {
        val j = r.jump
        if (j == null) {
          trackChorus(bar)
          advance(bar)
          Decision.Carry
        } else {
          jumpsTaken++
          advance(j.toBar)
          Decision.Jump(j, r.why)
        }
      }
    }
  }

  private fun advance(bar: Int) {
    if (bar < 0 || bar >= n) return
    val dt = barT[bar + 1] - barT[bar]
    t += dt
    visitT += dt
  }

  private fun sectionAt(bar: Int): Int = sections.indexOfFirst { bar >= it.startBar && bar < it.endBar }
  private fun kindAt(i: Int) = kinds.getOrNull(i) ?: "section"

  private fun trackChorus(bar: Int) {
    val i = sectionAt(bar)
    if (i < 0 || kindAt(i) != "chorus") {
      chorusFrom = -1
      return
    }
    val s = sections[i]
    if (bar == s.startBar) chorusFrom = s.startBar
    if (bar == s.endBar - 1 && chorusFrom == s.startBar) chorusDone = true
  }

  private fun isPhrase(bar: Int): Boolean {
    if (bar == 0) return true
    val i = sectionAt(bar)
    return i >= 0 && (bar - sections[i].startBar) % 4 == 0
  }

  fun nextPhrase(bar: Int): Int {
    for (b in (bar + 1) until n) if (isPhrase(b)) return b
    return n
  }

  /** Fallback destination: back toward the connected part of the graph, at close tempos. */
  private fun pickTarget(): String? {
    val here = cur ?: return null
    val ids = graph.tracks.keys.filter { allowed(it) }.sorted()
    if (ids.isEmpty()) {
      val others = graph.tracks.keys.filter { it != here.id && graph.tracks[it]?.walkable == true && graph.tracks[it]?.key != here.key && pool?.contains(it) != false }.sorted()
      val last = history.toMap()
      return others.minByOrNull { last[graph.tracks[it]?.key] ?: -1.0 }
    }
    val withExits = ids.filter { (graph.tracks[it]?.exits ?: 0) > 0 }.ifEmpty { ids }
    val near = withExits.sortedBy { abs((graph.tracks[it]?.bpm ?: 0.0) - here.bpm) }.take(CUT_POOL)
    return near[rng.nextInt(near.size)]
  }

  private fun cut(kind: String, bar: Int): Move? {
    val id = fallback?.takeIf { it in graph.tracks && it !in bad } ?: pickTarget() ?: return null
    return Move(kind, id, graph.tracks.getValue(id).entries.first(), bar, "cut")
  }

  private fun versions(): List<String> {
    val g = cur?.group.orEmpty()
    return if (g.isEmpty()) emptyList() else graph.tracks.values.filter { it.group == g && it.id != cur?.id && it.id !in bad && it.walkable }.map { it.id }
  }

  private fun fallbackMove(bar: Int, looped: Double): Move? {
    val c = cur ?: return null
    val came = cameFrom
    // The seam matched over the 4 bars after it, so any of them can go back, at that offset.
    if (came != null && bar - came.third in 0 until BACK_REACH_BARS && came.first in graph.tracks) {
      return Move("back", came.first, came.second + bar - came.third, bar, "back", 0.0, -cameOffsetMs)
    }
    if (looped >= BREAK_AFTER_S && bar in c.breakExits) return cut("break", bar)
    if (looped >= VERSION_AFTER_S && isPhrase(bar)) {
      val vs = versions()
      if (vs.isNotEmpty()) {
        val v = vs[rng.nextInt(vs.size)]
        val other = graph.tracks.getValue(v)
        val land = (bar * (other.bars.toDouble() / maxOf(1, c.bars))).roundToInt()
        return Move("version", v, minOf(land, other.bars - 1), bar, "version")
      }
    }
    if (looped >= CUT_AFTER_S && isPhrase(bar)) return cut("cut", bar)
    return null
  }

  private fun songEnd(bar: Int): Move {
    val here = cur?.id.orEmpty()
    val vs = if (forever || deadSince != null) versions() else emptyList()
    if (vs.isNotEmpty()) return Move("version", vs[rng.nextInt(vs.size)], 0, bar, "version")
    if (forever) return Move("end", here, 0, bar, "repeat") // (d) repeat-one
    return cut("cut", bar)?.copy(toBar = 0) ?: Move("end", here, 0, bar, "repeat") // a one-song pool
  }

  /** Next: a close portal at its own bar, else a cut on the next phrase (null: nowhere to go). */
  fun nextNow(bar: Int): Move? {
    for (b in maxOf(0, bar + 1) until minOf(n, bar + 1 + NEXT_REACH_BARS)) {
      portalsFrom(b).maxByOrNull(::rank)?.let { return Move("portal", it.to, it.toBar, b, it.pair, it.score, it.offsetMs) }
    }
    if (forever) return null // no other version in reach: the engine switches version itself
    val at = nextPhrase(bar)
    cur?.portals.orEmpty().filter { edgeOk(it) && it.fromBar > bar }.maxByOrNull(::rank)?.let {
      return Move("cut", it.to, it.toBar, at, it.pair, it.score)
    }
    return cut("cut", at)
  }

  /**
   * Next x2 in Forever: a completely different song, now (Forever stays on and loops it). A
   * portal if one is on the next two bars, else a cut on the next downbeat, into a portal's
   * landing if this song has one, else the fallback song's best entry. Null: nowhere to go.
   */
  fun newSong(bar: Int): Move? {
    val others = cur?.portals.orEmpty().filter { !it.sameGroup && it.score >= PORTAL_SCORE_MIN && allowed(it.to) }
    val at = maxOf(0, bar + 1)
    others.filter { it.fromBar == at || it.fromBar == at + 1 }.maxByOrNull(::rank)?.let {
      return Move("portal", it.to, it.toBar, it.fromBar, it.pair, it.score, it.offsetMs)
    }
    others.maxByOrNull(::rank)?.let { return Move("cut", it.to, it.toBar, at, it.pair, it.score) }
    return cut("cut", at)
  }

  companion object {
    const val DWELL_MIN = 60.0
    const val DWELL_MAX = 90.0
    const val MIN_DWELL_S = 30.0
    const val NO_REPEAT_COUNT = 8
    const val NO_REPEAT_S = 20 * 60.0
    const val PORTAL_SCORE_MIN = 0.6
    const val EXITS_BONUS = 0.05
    const val CUT_POOL = 12
    const val BREAK_AFTER_S = 30.0
    const val VERSION_AFTER_S = 60.0
    const val CUT_AFTER_S = 90.0
    const val BACK_REACH_BARS = 4
    const val NEXT_REACH_BARS = 8
    const val STAY_HOLD_S = 45.0
  }
}
