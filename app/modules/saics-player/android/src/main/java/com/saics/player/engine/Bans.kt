package com.saics.player.engine

/**
 * Songs that wouldn't open or decode. A failure is often passing (the phone short of memory or
 * of decoders while it analyses a song), so a ban runs out: 2 minutes, then 15, and only a third
 * failure keeps the song out for the rest of the session. Choosing the song again forgives it.
 */
class Bans(private val clockMs: () -> Long = { System.nanoTime() / 1_000_000 }) {
  private val until = HashMap<String, Long>()
  private val strikes = HashMap<String, Int>()

  operator fun contains(id: String): Boolean = until[id]?.let { it > clockMs() } ?: false

  /** Records a failure. True when it starts a ban (not when the song was already out). */
  fun strike(id: String): Boolean {
    if (id in this) return false
    val n = (strikes[id] ?: 0) + 1
    strikes[id] = n
    until[id] = clockMs() + when (n) {
      1 -> FIRST_MS
      2 -> SECOND_MS
      else -> Long.MAX_VALUE / 2
    }
    return true
  }

  fun forgive(id: String) {
    until.remove(id)
  }

  companion object {
    const val FIRST_MS = 2 * 60_000L
    const val SECOND_MS = 15 * 60_000L
  }
}
