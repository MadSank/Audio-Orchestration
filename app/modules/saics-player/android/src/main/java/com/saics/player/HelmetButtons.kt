package com.saics.player

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent

/**
 * Cardo / Bluetooth media-button handling (PLAN.md "Helmet / Bluetooth control spec").
 *
 * Every play/pause variant (PLAY_PAUSE, PLAY, PAUSE, HEADSETHOOK) counts as the same button,
 * so the mapping works whichever key the helmet's firmware sends. Presses of one button that
 * follow each other within [multiWindowMs] are counted; the action fires when the window
 * closes (a single press therefore waits up to the window: acceptable on a bike), or at once
 * when the maximum count is reached (3 for play/pause, 2 for next/previous).
 */
class HelmetButtons(
  private val onAction: (button: Button, count: Int) -> Unit,
  private val onEvent: (Map<String, Any?>) -> Unit,
) {
  enum class Button { PLAY_PAUSE, NEXT, PREVIOUS }

  var multiWindowMs: Long = 700 // gap allowed between presses of a multi-press
  var tripleWindowMs: Long = 1000 // play/pause x3 must fit in this from the first press

  private val handler = Handler(Looper.getMainLooper())
  private var pending: Button? = null
  private var count = 0
  private var firstAt = 0L
  private var lastAt = 0L
  private var lastAnyAt = 0L
  private val fire = Runnable { flush() }

  /** Returns true when the key was a media key we own (so the framework default is skipped). */
  fun onKeyEvent(event: KeyEvent): Boolean {
    val button = toButton(event.keyCode) ?: return false
    if (event.action != KeyEvent.ACTION_DOWN) return true // consume UP so nothing else reacts
    if (event.repeatCount > 0) return true // long-press auto-repeat is ignored
    press(button, event.keyCode)
    return true
  }

  /** Same as a real key press; used by the Button test screen and instrumented tests. */
  fun press(button: Button, keyCode: Int = 0) {
    val now = SystemClock.uptimeMillis()
    val sinceLast = if (lastAnyAt == 0L) null else now - lastAnyAt
    lastAnyAt = now
    if (pending != null && pending != button) flush() // a different button ends the sequence
    if (pending == null) {
      pending = button
      count = 0
      firstAt = now
    }
    count += 1
    lastAt = now
    onEvent(mapOf(
      "type" to "press", "button" to button.name, "keyCode" to keyCode,
      "keyName" to (if (keyCode != 0) KeyEvent.keyCodeToString(keyCode) else "SIMULATED"),
      "count" to count, "sinceLastMs" to sinceLast, "at" to System.currentTimeMillis(),
    ))
    handler.removeCallbacks(fire)
    val max = if (button == Button.PLAY_PAUSE) 3 else 2
    if (count >= max) {
      flush()
    } else {
      handler.postDelayed(fire, multiWindowMs)
    }
  }

  private fun flush() {
    handler.removeCallbacks(fire)
    val b = pending ?: return
    var n = count
    if (b == Button.PLAY_PAUSE && n == 3 && lastAt - firstAt > tripleWindowMs) n = 2
    pending = null
    count = 0
    onEvent(mapOf("type" to "action", "button" to b.name, "count" to n, "at" to System.currentTimeMillis()))
    onAction(b, n)
  }

  companion object {
    fun toButton(keyCode: Int): Button? = when (keyCode) {
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY,
      KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> Button.PLAY_PAUSE
      KeyEvent.KEYCODE_MEDIA_NEXT -> Button.NEXT
      KeyEvent.KEYCODE_MEDIA_PREVIOUS -> Button.PREVIOUS
      else -> null
    }
  }
}
