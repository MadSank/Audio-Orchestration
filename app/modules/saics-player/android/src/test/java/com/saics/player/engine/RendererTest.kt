package com.saics.player.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererTest {
  /** A song whose sample values encode their own position (exact in 16 bits). */
  private fun ramp(frames: Int, offset: Int = 0) = Pcm(frames).apply {
    for (i in 0 until frames) {
      val v = (((i + offset) % 20000) - 10000) / 32768f
      put(v, -v)
    }
    complete = true
  }

  private fun const(frames: Int, l: Float, r: Float) = Pcm(frames).apply {
    repeat(frames) { put(l, r) }
    complete = true
  }

  private fun renderer(vararg pcms: Pcm): Renderer {
    val slots = Array(4) { Slot() }
    pcms.forEachIndexed { i, p -> slots[i].pcm = p }
    return Renderer(slots).apply {
      playing = true
      pending.set(Instruction(-1, -1, 0, 0, 0)) // start slot 0 at frame 0
    }
  }

  /** Renders [frames] frames in blocks; returns the left channel. */
  private fun run(r: Renderer, frames: Int, block: Int = 512, onBlock: (Int) -> Unit = {}): FloatArray {
    val out = FloatArray(frames)
    val buf = FloatArray(block * 2)
    var done = 0
    while (done < frames) {
      onBlock(done)
      val n = minOf(block, frames - done)
      r.render(buf, n)
      for (i in 0 until n) out[done + i] = buf[2 * i]
      done += n
    }
    return out
  }

  private val fadeFrames = (Renderer.FADE_S * ENGINE_RATE).toInt() + 1

  @Test fun jumpIsSampleExact() {
    val song = ramp(40000)
    val r = renderer(song)
    val out = run(r, 20000) { done -> if (done == 512) r.pending.set(Instruction(0, 12000, 0, 3000, 0)) }
    for (k in fadeFrames until 12000) assertEquals("before seam @$k", song.left(k), out[k], 1e-6f)
    for (j in 0 until 8000) assertEquals("after seam @$j", song.left(3000 + j), out[12000 + j], 1e-6f)
  }

  @Test fun crossfadeIsCentredOnTheSeam() {
    val song = ramp(40000)
    val r = renderer(song)
    val half = 300
    val out = run(r, 20000) { done -> if (done == 512) r.pending.set(Instruction(0, 12000, 0, 3000, half)) }
    for (k in fadeFrames until 12000 - half) assertEquals(song.left(k), out[k], 1e-6f)
    // After the crossfade the beat grid continues exactly as if the jump were a hard cut.
    for (j in half until 8000) assertEquals(song.left(3000 + j), out[12000 + j], 1e-6f)
  }

  @Test fun identicalAudioCrossfadesWithoutABump() {
    val r = renderer(const(30000, 0.5f, 0.5f))
    val half = 400
    val out = run(r, 20000) { done -> if (done == 512) r.pending.set(Instruction(0, 12000, 0, 3000, half, rho = 1.0)) }
    for (k in 12000 - half until 12000 + half) assertEquals("@$k", 0.5f, out[k], 1e-3f)
  }

  @Test fun uncorrelatedAudioCrossfadesAtConstantPower() {
    val r = renderer(const(30000, 0.5f, 0f), const(30000, 0f, 0.5f))
    val half = 400
    val buf = FloatArray(2)
    for (k in 0 until 20000) {
      if (k == 512) r.pending.set(Instruction(0, 12000, 1, 3000, half, rho = 0.0))
      r.render(buf, 1)
      if (k in 12000 - half until 12000 + half) {
        assertEquals("power @$k", 0.25f, buf[0] * buf[0] + buf[1] * buf[1], 2e-3f)
      }
    }
  }

  @Test fun gapThenRestart() {
    val song = ramp(40000)
    val r = renderer(song)
    val out = run(r, 20000) { done -> if (done == 512) r.pending.set(Instruction(0, 10000, 0, 0, 0, gap = 1000)) }
    for (k in 10000 until 11000) assertEquals(0f, out[k], 0f)
    for (j in 0 until 5000) assertEquals(song.left(j), out[11000 + j], 1e-6f)
  }

  @Test fun noInstructionMeansTheSongJustContinues() {
    val song = ramp(40000)
    val out = run(renderer(song), 30000)
    for (k in fadeFrames until 30000) assertEquals(song.left(k), out[k], 1e-6f)
  }

  @Test fun staleInstructionForAnotherSongIsDropped() {
    val song = ramp(40000)
    val r = renderer(song, ramp(40000, 5))
    val out = run(r, 20000) { done -> if (done == 1024) r.pending.set(Instruction(1, 8000, 1, 0, 0)) }
    for (k in fadeFrames until 20000) assertEquals(song.left(k), out[k], 1e-6f)
  }

  @Test fun renderLoopAllocatesNothing() {
    val r = renderer(ramp(200000), ramp(200000, 777))
    r.vinylOn = true
    val buf = FloatArray(1024)
    repeat(300) { r.render(buf, 512) } // warm up (JIT, class loading)
    r.pending.set(Instruction(0, r.frame + 2000, 1, 5000, 600, rho = 0.3)) // allocated before measuring
    // Unit tests compile against android.jar (no java.lang.management): reach the JDK's
    // per-thread allocation counter reflectively.
    val mx = Class.forName("java.lang.management.ManagementFactory").getMethod("getThreadMXBean").invoke(null)
    val allocated = Class.forName("com.sun.management.ThreadMXBean")
      .getMethod("getThreadAllocatedBytes", Long::class.javaPrimitiveType)
    val id = Thread.currentThread().id
    val start = allocated.invoke(mx, id) as Long
    repeat(100) { r.render(buf, 512) }
    val used = (allocated.invoke(mx, id) as Long) - start
    assertEquals("the jump was executed", 2, r.executed)
    assertTrue("render loop allocated $used bytes", used < 256)
  }
}
