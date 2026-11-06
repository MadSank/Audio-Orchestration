package com.saics.player

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import kotlin.math.PI
import kotlin.math.sin

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
  // Our own one-shot buffers: a static track with no loop points plays once and stops. The system
  // ToneGenerator runs a state machine that can keep sounding until the next tone replaces it.
  private val tones = HashMap<String, AudioTrack?>()

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
    val key = if (kind in EARCONS) kind else "step"
    val track = tones.getOrPut(key) { buildTone(render(EARCONS.getValue(key))) } ?: return
    try {
      if (track.playState == AudioTrack.PLAYSTATE_PLAYING) track.stop()
      track.reloadStaticData() // back to the first sample
      track.play()
    } catch (e: IllegalStateException) {
      tones.remove(key)?.release()
    }
  }

  private fun buildTone(pcm: ShortArray): AudioTrack? = try {
    AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
      )
      .setAudioFormat(
        AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build(),
      )
      .setBufferSizeInBytes(pcm.size * 2)
      .setTransferMode(AudioTrack.MODE_STATIC)
      .build()
      .also { it.write(pcm, 0, pcm.size) }
  } catch (e: RuntimeException) {
    null
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
    tones.values.forEach { it?.release() }
    tones.clear()
  }

  companion object {
    private const val RATE = 44100
    private const val LEVEL = 0.3
    private const val EDGE_MS = 5.0

    /** kind -> notes as (Hz, ms); 0 Hz is a rest. */
    val EARCONS = mapOf(
      "on" to listOf(660.0 to 70.0, 990.0 to 90.0),
      "off" to listOf(990.0 to 70.0, 660.0 to 90.0),
      "step" to listOf(880.0 to 70.0),
      "error" to listOf(330.0 to 120.0, 0.0 to 60.0, 330.0 to 120.0),
    )

    /** The notes as 16-bit PCM, each with short raised-cosine edges so it never clicks. */
    fun render(notes: List<Pair<Double, Double>>): ShortArray {
      val out = ArrayList<Short>()
      for ((hz, ms) in notes) {
        val n = (ms / 1000 * RATE).toInt()
        val edge = (EDGE_MS / 1000 * RATE).toInt()
        for (i in 0 until n) {
          val env = sin(PI / 2 * minOf(1.0, minOf(i, n - 1 - i).toDouble() / edge)).let { it * it }
          out.add((sin(2 * PI * hz * i / RATE) * env * LEVEL * 32767).toInt().toShort())
        }
      }
      return out.toShortArray()
    }
  }
}
