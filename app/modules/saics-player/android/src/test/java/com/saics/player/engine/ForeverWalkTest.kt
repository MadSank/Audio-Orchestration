package com.saics.player.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The walk follows forever_path's rules (engine/tests/test_jumps.py checks the Python side). */
class ForeverWalkTest {
  // 80 bars of 2 s: intro A(0-8) B1(8-24) C1(24-40) B2(40-56) C2(56-72) outro D(72-80).
  private val barT = DoubleArray(81) { it * 2.0 }
  private val sections = listOf(
    Bundle.Section(0, 8, 0), Bundle.Section(8, 24, 1), Bundle.Section(24, 40, 2),
    Bundle.Section(40, 56, 1), Bundle.Section(56, 72, 2), Bundle.Section(72, 80, 3),
  )
  private val jumps = listOf(
    Bundle.Jump(44, 12, 0.92, "repeat", "B2:5 → B1:5"),
    Bundle.Jump(14, 46, 0.90, "repeat", "B1:7 → B2:7"),
    Bundle.Jump(60, 28, 0.88, "repeat", "C2:5 → C1:5"),
    Bundle.Jump(30, 62, 0.86, "repeat", "C1:7 → C2:7"),
  )

  private data class Taken(val atS: Double, val from: Int, val to: Int, val why: String)

  /** Plays the walk for [seconds]; returns the jumps taken and whether the end was reached. */
  private fun walk(w: ForeverWalk, seconds: Double): Pair<List<Taken>, Boolean> {
    val taken = mutableListOf<Taken>()
    var t = 0.0
    var bar = -1
    while (t < seconds) {
      val next = bar + 1
      when (val s = w.step(next)) {
        is ForeverWalk.Step.Play -> {
          if (s.jump != null) taken.add(Taken(t, next, s.bar, s.why))
          bar = s.bar
          t += barT[bar + 1] - barT[bar]
        }
        ForeverWalk.Step.End -> return taken to true
      }
    }
    return taken to false
  }

  private fun forever(seed: Long, loopable: Boolean = true) =
    ForeverWalk(barT, sections, jumps, outroBar = 72, loopable = loopable, seed = seed)

  @Test fun theLastBackwardJumpBeforeTheOutroIsTheLastChance() {
    assertEquals(60, forever(1).lastBack)
  }

  @Test fun theEndingIsAvoidedAtMostTwiceThenArrives() {
    repeat(10) { seed ->
      val (taken, ended) = walk(forever(seed.toLong()), 3600.0)
      val avoid = taken.filter { it.why == "avoid the ending" }
      assertTrue("seed $seed: avoided at least once", avoid.isNotEmpty())
      assertTrue("seed $seed: each loop used at most twice", avoid.groupBy { it.from to it.to }.values.all { it.size <= 2 })
      assertTrue("seed $seed: the ending arrives once the loops are used up", ended)
    }
  }

  @Test fun pacedJumpsNeverLandWithinAMinuteOfTheLastChance() {
    repeat(20) { seed ->
      val (taken, _) = walk(forever(seed.toLong()), 3600.0)
      for (j in taken.filter { it.why == "pacing" }) {
        assertTrue("seed $seed: landed at bar ${j.to}", barT[60] - barT[j.to] >= 60.0)
      }
    }
  }

  @Test fun pacingWaitsAtLeastAMinute() {
    repeat(20) { seed ->
      val (taken, _) = walk(forever(seed.toLong()), 3600.0)
      taken.firstOrNull { it.why == "pacing" }?.let { assertTrue("seed $seed: first at ${it.atS} s", it.atS >= 60.0) }
    }
  }

  @Test fun notLoopableSongsGoStraightToTheEnding() {
    val w = forever(1, loopable = false)
    assertNull(w.lastBack)
    val (taken, ended) = walk(w, 3600.0)
    assertTrue(ended)
    assertTrue(taken.none { it.why == "avoid the ending" })
  }

  @Test fun bundleBarTimesRunTheLastBarToTheEndOfTheAudio() {
    val b = Bundle(doubleArrayOf(0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5), intArrayOf(0, 4, 8),
      emptyList(), emptyList(), null, true, 0.0)
    assertEquals(listOf(0.5, 2.5, 5.2), b.barTimes(5.2).toList())
  }

  @Test fun olderSchemaBundlesAreIgnored() {
    assertNull(Bundle.parse("""{"schema": "saics.analysis/8", "beats": [], "downbeats": []}"""))
  }
}
