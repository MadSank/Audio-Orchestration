package com.saics.player.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** The walk's rules; engine/tests/test_portals.py checks the same ones on mixwalk.py. */
class MixWalkTest {
  private val secs = (0 until 5).map { Bundle.Section(it * 16, it * 16 + 16, it) }
  private val kinds = (0 until 5).map { if (it % 2 == 1) "chorus" else "verse" }
  private val barT = DoubleArray(81) { it * 2.0 }

  private fun edge(from: Int, to: String, toBar: Int, same: Boolean = false, score: Double = 0.9) =
    PortalGraph.Edge(from, to, toBar, score, "chorus → chorus", same)

  private fun track(id: String, group: String = id, portals: List<PortalGraph.Edge> = emptyList(), breaks: Set<Int> = emptySet(), bars: Int = 80) =
    PortalGraph.Track(id, group, 120.0, "8A", kinds, bars, listOf(8, 0), breaks, portals)

  private fun graph(vararg t: PortalGraph.Track) = PortalGraph(t.associateBy { it.id })

  private fun MixWalk.go(g: PortalGraph, id: String, jumps: List<Bundle.Jump> = emptyList(), came: Triple<String, Int, Int>? = null) =
    enter(g.tracks.getValue(id), barT, secs, jumps, null, true, 0, came)

  /** Plays [bars] bars from [from] and returns the first Leave (linear, following jumps). */
  private fun MixWalk.playUntilLeave(from: Int = 0, limit: Int = 4000): Move? {
    var bar = from
    repeat(limit) {
      when (val d = step(bar)) {
        MixWalk.Decision.Carry -> bar++
        is MixWalk.Decision.Jump -> bar = d.jump.toBar + 1
        is MixWalk.Decision.Leave -> return d.move
      }
    }
    return null
  }

  @Test fun portalWaitsForTheDwell() {
    val g = graph(track("a", portals = listOf(edge(4, "b", 8), edge(40, "b", 8))), track("b"))
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    val m = w.playUntilLeave()!!
    assertEquals("the bar 4 portal comes before the dwell", 40, m.at)
    assertEquals("portal", m.kind)
    assertTrue(w.t >= MixWalk.MIN_DWELL_S)
  }

  @Test fun anotherVersionOnlyWithForever() {
    val g = graph(track("a", "song", listOf(edge(40, "b", 40, same = true), edge(48, "c", 8))), track("b", "song"), track("c"))
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    assertEquals("c", w.playUntilLeave()!!.to)
    val f = MixWalk(g, Random(1)).also { it.forever = true }
    f.go(g, "a")
    assertEquals("b", f.playUntilLeave()!!.to)
  }

  @Test fun recentGroupsAreNotRevisited() {
    val g = graph(track("a", portals = listOf(edge(40, "b", 8))), track("b", portals = listOf(edge(40, "a", 8), edge(48, "c", 8))), track("c"))
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    val m = w.playUntilLeave()!!
    assertEquals("b", m.to)
    w.left()
    w.go(g, "b")
    assertEquals("not straight back to a", "c", w.playUntilLeave()!!.to)
  }

  @Test fun deadEndLeavesBackThroughThePortalItCameIn() {
    val loop = Bundle.Jump(40, 8, 0.9, "repeat", "loop")
    val g = graph(track("a", portals = listOf(edge(40, "b", 8))), track("b"), track("c"))
    val w = MixWalk(g, Random(3))
    w.go(g, "a")
    w.left()
    w.go(g, "b", listOf(loop), came = Triple("a", 40, 8))
    val m = w.playUntilLeave(8)!!
    assertEquals("back", m.kind)
    assertEquals("a", m.to)
    assertTrue("lands at the matching offset, got ${m.toBar}", m.toBar - 40 == m.at - 8 && m.at - 8 in 0..3)
  }

  @Test fun neverTrapped() {
    val g = graph(track("a"), track("b"), track("c"))
    repeat(20) { seed ->
      val w = MixWalk(g, Random(seed))
      w.go(g, "a", listOf(Bundle.Jump(70, 20, 0.9, "repeat", "loop")))
      assertNotNull("seed $seed", w.playUntilLeave())
    }
  }

  @Test fun onlySongInThePoolRepeats() {
    val g = graph(track("a"))
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    assertEquals("end", w.playUntilLeave()!!.kind)
  }

  @Test fun foreverNeverCutsToAnotherSong() {
    val g = graph(track("a", "song"), track("c", "other"))
    val w = MixWalk(g, Random(1)).also { it.forever = true }
    w.go(g, "a")
    assertEquals("end", w.playUntilLeave()!!.kind)
    assertNull("Next finds no other version: the engine handles it", w.nextNow(10))
  }

  @Test fun stayDropsTheOfferAndHoldsTheFallbacks() {
    val g = graph(track("a", portals = listOf(edge(60, "b", 8))), track("b"))
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    for (b in 0 until 50) assertEquals(MixWalk.Decision.Carry, w.step(b)) // 100 s: dwell is over
    val offer = w.peek(50)!!
    assertEquals(60, offer.at)
    w.stay(offer)
    assertNull(w.peek(50))
    for (b in 50 until 62) assertEquals("no fallback and no portal after Stay", MixWalk.Decision.Carry, w.step(b))
  }

  @Test fun nextTakesACloseOneElseCutsOnThePhrase() {
    val g = graph(track("a", portals = listOf(edge(40, "b", 8), edge(72, "c", 8))), track("b"), track("c"))
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    val near = w.nextNow(36)!!
    assertEquals("portal", near.kind)
    assertEquals(40, near.at)
    val far = w.nextNow(50)!!
    assertEquals("cut", far.kind)
    assertEquals(52, far.at)
    assertEquals("c", far.to)
  }

  @Test fun doubleNextInForeverGoesToADifferentSong() {
    val g = graph(
      track("a", "song", listOf(edge(40, "v", 8, same = true), edge(40, "c", 8), edge(70, "d", 16))),
      track("v", "song"), track("c"), track("d"), track("e"),
    )
    val w = MixWalk(g, Random(3)).also { it.forever = true }
    w.go(g, "a")
    val close = w.newSong(38)!!
    assertEquals("portal", close.kind)
    assertEquals(40, close.at)
    assertEquals("c", close.to)
    val far = w.newSong(10)!!
    assertEquals("cut", far.kind)
    assertEquals(11, far.at)
    assertTrue(far.to == "c" || far.to == "d")
    val lone = graph(track("a", "song"), track("v", "song"), track("e"))
    val l = MixWalk(lone, Random(3)).also { it.forever = true }
    l.go(lone, "a")
    assertEquals("e", l.newSong(10)!!.to)
  }

  @Test fun aSongThatWontPlayIsNeverWalkedInto() {
    val g = graph(track("a", portals = listOf(edge(40, "b", 8), edge(48, "c", 8))), track("b"), track("c"))
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    w.markBad("b")
    assertEquals("c", w.playUntilLeave()!!.to)
    assertTrue("the fallback isn't it either", w.fallback != "b")
  }

  /** Same answers as engine/tests/test_seams.py. */
  @Test fun theTrimMakesUpTheStepButNeverMoreThanTheLimit() {
    val a = DoubleArray(8) { -14.0 }
    fun b(db: Double) = DoubleArray(8) { db }
    assertEquals(4.0, Seams.trimDb(a, 4, b(-18.0), 4), 1e-9)
    assertEquals(-3.0, Seams.trimDb(a, 4, b(-11.0), 4), 1e-9)
    assertEquals(Seams.TRIM_MAX_DB, Seams.trimDb(a, 4, b(-40.0), 4), 1e-9)
    assertEquals(0.0, Seams.trimDb(a, 4, b(-14.2), 4), 1e-9)
    assertEquals(0.0, Seams.trimDb(a, 4, b(-30.0), 0), 1e-9)
    assertEquals(0.0, Seams.trimDb(DoubleArray(0), 4, b(-30.0), 4), 1e-9)
  }

  @Test fun anUnwalkableSongIsNeverATarget() {
    val lofi = PortalGraph.Track("lofi", "lofi", 120.0, "8A", kinds, 80, listOf(8, 0), emptySet(), emptyList(), walkable = false)
    val g = graph(track("a", portals = listOf(edge(40, "lofi", 8), edge(48, "b", 8))), track("b"), lofi)
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    assertEquals("b", w.playUntilLeave()!!.to)
    assertTrue(w.fallback != "lofi")
  }

  @Test fun onlyAPortalIntoASongsMiddleMovesItsSeamEarly() {
    assertEquals(Seams.EARLY_MS, Seams.earlyMs("portal", 8), 1e-9)
    assertEquals(Seams.EARLY_MS, Seams.earlyMs("back", 8), 1e-9)
    assertEquals(0.0, Seams.earlyMs("portal", 0), 1e-9)
    assertEquals(0.0, Seams.earlyMs("cut", 8), 1e-9)
    assertEquals(false, Seams.LANDING_TRIM)
  }

  @Test fun aPortalCarriesItsNudgeAndGoingBackUndoesIt() {
    val g = graph(track("a", portals = listOf(PortalGraph.Edge(40, "b", 8, 0.9, "chorus → chorus", false, 12.5))), track("b"))
    val w = MixWalk(g, Random(1))
    w.go(g, "a")
    assertEquals(12.5, w.playUntilLeave()!!.offsetMs, 1e-9)
    val loop = Bundle.Jump(40, 8, 0.9, "repeat", "loop")
    w.enter(g.tracks.getValue("b"), barT, secs, listOf(loop), null, true, 0, Triple("a", 40, 8), 12.5)
    val back = w.playUntilLeave(8)!!
    assertEquals("back", back.kind)
    assertEquals(-12.5, back.offsetMs, 1e-9)
  }

  @Test fun graphParses() {
    val g = PortalGraph.parse(
      """{"schema":"saics.portals/2","generated":"x","tracks":{"a":{"file":"a.mp3","group":"g","bpm":120.0,"camelot":"8A",
      "sections":["intro"],"bars":40,"entries":[8,0],"break_exits":[12],"level_out":[-14.5,-13.0],"level_in":[-12.0,-11.0],"walkable":false,
      "portals":[{"from_bar":8,"to":"b","to_bar":4,"score":0.8,"pair":"chorus → chorus","context":0.5,"harmony":0.9,"same_group":false,"two_way":true,"offset_ms":-7.5}]}}}""",
    )!!
    val a = g.tracks.getValue("a")
    assertEquals(1, a.exits)
    assertEquals(8, a.portals[0].fromBar)
    assertEquals(-7.5, a.portals[0].offsetMs, 1e-9)
    assertEquals(-13.0, a.levelOut[1], 1e-9)
    assertEquals(-12.0, a.levelIn[0], 1e-9)
    assertEquals(false, a.walkable)
    assertNull(PortalGraph.parse("""{"schema":"saics.portals/1","tracks":{}}"""))
  }
}
