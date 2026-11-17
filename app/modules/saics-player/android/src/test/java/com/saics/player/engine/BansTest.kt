package com.saics.player.engine

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BansTest {
  private var now = 0L
  private val bans = Bans { now }

  @Test fun aFailureRunsOutAndTheSecondLastsLonger() {
    assertTrue(bans.strike("a"))
    assertTrue("a" in bans)
    assertFalse("already out: not a new ban", bans.strike("a"))
    now += Bans.FIRST_MS + 1
    assertFalse("back after the first ban", "a" in bans)
    bans.strike("a")
    now += Bans.FIRST_MS + 1
    assertTrue("the second ban is longer", "a" in bans)
    now += Bans.SECOND_MS
    assertFalse("a" in bans)
  }

  @Test fun theThirdFailureLastsTheSessionUnlessTheSongIsChosen() {
    repeat(3) {
      bans.strike("a")
      now += Bans.SECOND_MS + 1
    }
    assertTrue("a" in bans)
    bans.forgive("a")
    assertFalse("chosen again: forgiven", "a" in bans)
    assertFalse("other songs never banned", "b" in bans)
  }
}
