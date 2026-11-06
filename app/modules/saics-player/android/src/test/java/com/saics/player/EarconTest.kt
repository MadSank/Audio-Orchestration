package com.saics.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EarconTest {
  @Test
  fun everyEarconIsShortAndStartsAndEndsAtSilence() {
    for ((kind, notes) in Feedback.EARCONS) {
      val pcm = Feedback.render(notes)
      assertTrue("$kind is ${pcm.size} samples", pcm.size in 1000..(44100 / 2))
      assertEquals(kind, 0, pcm.first().toInt())
      assertTrue("$kind ends at ${pcm.last()}", kotlin.math.abs(pcm.last().toInt()) < 100)
      val peak = pcm.maxOf { kotlin.math.abs(it.toInt()) }
      assertTrue("$kind peak $peak", peak in 8000..11000)
    }
  }

  @Test
  fun aRestIsSilent() {
    val pcm = Feedback.render(listOf(0.0 to 50.0))
    assertTrue(pcm.all { it.toInt() == 0 })
  }
}
