package com.saics.player

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * Audio feedback for a screen-off ride: a short earcon for every mode change, optionally
 * followed by a brief spoken line. The music is ducked while the line is spoken.
 */
class Feedback(context: Context, private val duck: (Boolean) -> Unit) {
  var earcons = true
  var speech = true

  private val main = Handler(Looper.getMainLooper())
  private var ttsReady = false
  private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
    ttsReady = status == TextToSpeech.SUCCESS
    if (ttsReady) {
      tts.language = Locale.US
      tts.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build(),
      )
    }
  }
  private val tone = try {
    ToneGenerator(AudioManager.STREAM_MUSIC, 70)
  } catch (e: RuntimeException) {
    null
  }

  init {
    tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(id: String?) {
        main.post { duck(true) }
      }

      override fun onDone(id: String?) {
        main.post { duck(false) }
      }

      @Deprecated("Deprecated in Java")
      override fun onError(id: String?) {
        main.post { duck(false) }
      }
    })
  }

  /** kind: "on" (rising), "off" (falling), "step" (neutral), "error". */
  fun earcon(kind: String) {
    if (!earcons) return
    val t = when (kind) {
      "on" -> ToneGenerator.TONE_PROP_ACK
      "off" -> ToneGenerator.TONE_PROP_NACK
      "error" -> ToneGenerator.TONE_SUP_ERROR
      else -> ToneGenerator.TONE_PROP_BEEP
    }
    tone?.startTone(t, 150)
  }

  fun say(text: String) {
    if (!speech || !ttsReady) return
    tts.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), "saics-${System.nanoTime()}")
  }

  fun confirm(kind: String, text: String) {
    earcon(kind)
    if (speech) main.postDelayed({ say(text) }, 250)
  }

  fun release() {
    tts.shutdown()
    tone?.release()
  }
}
