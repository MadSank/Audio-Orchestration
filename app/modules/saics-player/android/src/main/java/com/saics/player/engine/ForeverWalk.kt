package com.saics.player.engine

import kotlin.random.Random

/**
 * Incremental port of engine/saics/jumps.py `forever_path` (rated in eval rounds 2 and 2b;
 * keep the two in step). The Python walk produces a whole render; this one is asked, one bar
 * ahead, what follows the bar now playing.
 *
 * Endings follow the owner's priority: (a) the last backward repeat jump before the outro is
 * always taken ("avoid the ending", at most AVOID_MAX_USES times), (b) else a break loop,
 * (c) else another version of the song group, (d) else repeat-one after a short gap.
 */
class ForeverWalk(
  private val barT: DoubleArray,
  sections: List<Bundle.Section>,
  jumps: List<Bundle.Jump>,
  outroBar: Int?,
  loopable: Boolean,
  seed: Long,
  private val pace: Pair<Double, Double> = 60.0 to 120.0,
) {
  sealed class Step {
    /** Play bar [bar] next (contiguous when it follows the current bar). */
    data class Play(val bar: Int, val jump: Bundle.Jump?, val why: String) : Step()
    /** The song ended: switch to another version (if the group has one) or repeat after a gap. */
    object End : Step()
  }

  private val rng = Random(seed)
  private val n = barT.size - 1
  private val outro = outroBar ?: n
  private val sec = IntArray(n) { -1 }.also { idx ->
    sections.forEachIndexed { k, s -> for (b in s.startBar until minOf(s.endBar, n)) if (b >= 0) idx[b] = k }
  }
  private val byFrom: Map<Int, List<Bundle.Jump>> =
    jumps.filter { it.kind == "repeat" || it.kind == "break" }.groupBy { it.fromBar }
  val lastBack: Int? = if (!loopable) null else run {
    val back = jumps.filter { (it.kind == "repeat" || it.kind == "break") && it.toBar < it.fromBar && it.fromBar <= outro }
    back.filter { it.kind == "repeat" }.maxOfOrNull { it.fromBar } ?: back.filter { it.kind == "break" }.maxOfOrNull { it.fromBar }
  }

  private var t = 0.0 // seconds played in this walk
  private var landed = -2
  private var nextAt = uniform()
  private val recent = ArrayDeque<Pair<Double, Int>>() // (time, bar) of bars played
  private val used = HashMap<String, Int>()

  private fun uniform() = pace.first + (pace.second - pace.first) * rng.nextDouble()

  /** Restart the walk at [bar] (song start, a version switch landing, or Previous). */
  fun reset(bar: Int) {
    landed = if (bar in 1 until n) sec[bar] else -2 // bar 0 = a fresh start, as in forever_path
    nextAt = t + uniform()
  }

  /**
   * What to play instead of / as bar [bar] (the bar that would follow the one playing now).
   * Returns Play(bar) for "carry on", Play(to, jump) to jump, or End.
   */
  fun step(bar: Int): Step {
    val here = byFrom[bar].orEmpty()
    while (recent.isNotEmpty() && t - recent.first().first >= 60.0) recent.removeFirst()
    val fresh = recent.mapTo(HashSet()) { it.second }
    if (lastBack != null && bar == lastBack) {
      val usable = here.filter { it.toBar < bar && (used[it.label] ?: 0) < AVOID_MAX_USES }
      val options = usable.filter { it.toBar !in fresh }.ifEmpty { usable }
      if (options.isNotEmpty()) {
        val j = options.maxWithOrNull(
          compareBy<Bundle.Jump> { it.kind == "repeat" }
            .thenBy { it.score - REUSE_PENALTY * (used[it.label] ?: 0) + 0.002 * (bar - it.toBar) },
        )!!
        return take(j, "avoid the ending")
      }
    }
    if (t >= nextAt && here.isNotEmpty() && bar < n && sec[bar] != landed) {
      val limit = lastBack ?: n
      val options = here.filter {
        it.toBar !in fresh && it.score - REUSE_PENALTY * (used[it.label] ?: 0) >= TAKE_MIN &&
          barT[limit] - barT[it.toBar] >= pace.first
      }
      if (options.isNotEmpty()) {
        val j = options.maxByOrNull { it.score - REUSE_PENALTY * (used[it.label] ?: 0) + rng.nextDouble() * 0.02 }!!
        return take(j, "pacing")
      }
    }
    if (bar >= n) return Step.End
    played(bar)
    return Step.Play(bar, null, "")
  }

  private fun take(j: Bundle.Jump, why: String): Step {
    used[j.label] = (used[j.label] ?: 0) + 1
    landed = sec[j.toBar]
    nextAt = t + uniform()
    played(j.toBar)
    return Step.Play(j.toBar, j, why)
  }

  private fun played(bar: Int) {
    recent.addLast(t to bar)
    t += barT[bar + 1] - barT[bar]
  }

  /** Repeat-one: the gap counts as played time, then the walk starts over at bar 0. */
  fun repeatOne() {
    t += REPEAT_ONE_GAP_S
    landed = -2
    nextAt = t + uniform()
  }

  companion object {
    // engine/saics/jumps.py
    const val REUSE_PENALTY = 0.3
    const val TAKE_MIN = 0.6
    const val REPEAT_ONE_GAP_S = 1.5
    const val AVOID_MAX_USES = 2
  }
}
