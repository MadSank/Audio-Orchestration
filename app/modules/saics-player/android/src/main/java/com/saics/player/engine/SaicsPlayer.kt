package com.saics.player.engine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import android.media.AudioAttributes as PlatformAttributes

/**
 * The Media3 face of the [Engine]: the session, notification and helmet buttons see a normal
 * Player. Replaces ExoPlayer's audio focus handling (pause for calls, resume after; navigation
 * prompts are ducked by the system) and becoming-noisy (helmet off: pause, never the speaker).
 */
class SaicsPlayer(private val context: Context) : SimpleBasePlayer(Looper.getMainLooper()), Engine.Listener {
  /** Maps a queue item to something the engine can play (set by the service). */
  var resolve: (MediaItem) -> Engine.Song = { Engine.Song(it.mediaId, it.localConfiguration!!.uri, null, it.mediaId, "", "original", 0.0) }
  /** Engine events for audio feedback / the UI (set by the service). */
  var onEngineAction: (String, String) -> Unit = { _, _ -> }
  /** The song now playing (may be another version than the queue item). */
  var itemFor: (Engine.Song) -> MediaItem? = { null }

  val engine = Engine(context, this)
  private val main = Handler(Looper.getMainLooper())
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var items: List<MediaItem> = emptyList()
  private var playWhenReady = false
  private var repeat = Player.REPEAT_MODE_ALL
  private var volume = 1f
  private var resumeOnGain = false
  private var hasFocus = false
  private var noisyRegistered = false
  // Keeps the CPU feeding the AudioTrack with the screen off (ExoPlayer's WAKE_MODE_LOCAL).
  private val wake = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "saics:playback").apply { setReferenceCounted(false) }

  private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
    .setAudioAttributes(
      PlatformAttributes.Builder().setUsage(PlatformAttributes.USAGE_MEDIA).setContentType(PlatformAttributes.CONTENT_TYPE_MUSIC).build(),
    )
    .setWillPauseWhenDucked(false) // navigation prompts: the system ducks us
    .setOnAudioFocusChangeListener({ change ->
      when (change) {
        AudioManager.AUDIOFOCUS_LOSS -> {
          resumeOnGain = false
          hasFocus = false
          setPlaying(false)
        }
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { // a call
          resumeOnGain = playWhenReady
          setPlaying(false)
        }
        AudioManager.AUDIOFOCUS_GAIN -> {
          hasFocus = true
          if (resumeOnGain) setPlaying(true)
          resumeOnGain = false
        }
      }
    }, main)
    .build()

  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
      if (i.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) setPlaying(false)
    }
  }

  private fun setPlaying(on: Boolean) {
    if (on) {
      if (!hasFocus) hasFocus = audio.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      if (!hasFocus) return
      if (!noisyRegistered) {
        context.registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
        noisyRegistered = true
      }
      wake.acquire()
      engine.play()
    } else {
      engine.pause()
      main.postDelayed({ if (!playWhenReady) wake.release() }, 500) // after the fade-out
      if (noisyRegistered) {
        context.unregisterReceiver(noisy)
        noisyRegistered = false
      }
    }
    playWhenReady = on
    invalidateState()
  }

  override fun getState(): State {
    val cur = engine.current
    var idx = items.indexOfFirst { it.mediaId == cur?.id }
    val list = items.toMutableList()
    if (idx < 0 && cur != null) { // another version of a queue item: show it in place
      val item = itemFor(cur)
      if (item != null) {
        idx = list.indexOfFirst { it.mediaId == lastQueueId }.takeIf { it >= 0 } ?: 0
        if (list.isNotEmpty()) list[idx] = item else list.add(item)
      }
    } else if (idx >= 0) {
      lastQueueId = items[idx].mediaId
    }
    val playlist = list.mapIndexed { i, m ->
      MediaItemData.Builder("$i:${m.mediaId}").setMediaItem(m).setIsSeekable(false)
        .setDurationUs(if (i == idx) engine.durationMs().takeIf { it > 0 }?.times(1000) ?: C.TIME_UNSET else C.TIME_UNSET)
        .build()
    }
    val b = State.Builder()
      .setAvailableCommands(COMMANDS)
      .setPlayWhenReady(playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setRepeatMode(repeat)
      .setVolume(volume)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build())
      .setPlaylist(playlist)
    if (playlist.isEmpty()) {
      b.setPlaybackState(Player.STATE_IDLE)
    } else {
      b.setPlaybackState(if (cur == null && playWhenReady) Player.STATE_BUFFERING else Player.STATE_READY)
        .setCurrentMediaItemIndex(idx.coerceIn(0, playlist.size - 1))
        .setContentPositionMs { engine.positionMs() }
    }
    return b.build()
  }

  private var lastQueueId: String? = null

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    setPlaying(playWhenReady)
    return Futures.immediateVoidFuture()
  }

  override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleStop(): ListenableFuture<*> {
    setPlaying(false)
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> {
    setPlaying(false)
    audio.abandonAudioFocusRequest(focusRequest)
    engine.release()
    if (wake.isHeld) wake.release()
    return Futures.immediateVoidFuture()
  }

  override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
    items = mediaItems.toList()
    engine.setQueue(items.map(resolve), if (startIndex == C.INDEX_UNSET) 0 else startIndex)
    return Futures.immediateVoidFuture()
  }

  override fun handleAddMediaItems(index: Int, mediaItems: MutableList<MediaItem>): ListenableFuture<*> {
    items = items.toMutableList().apply { addAll(index.coerceIn(0, size), mediaItems) }
    return Futures.immediateVoidFuture()
  }

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> engine.next(hard = false)
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> engine.previous()
      Player.COMMAND_SEEK_TO_MEDIA_ITEM, Player.COMMAND_SEEK_TO_DEFAULT_POSITION ->
        if (mediaItemIndex in items.indices) engine.setQueue(items.map(resolve), mediaItemIndex)
      else -> engine.previous() // seek within the item: restart (Forever positions aren't linear)
    }
    return Futures.immediateVoidFuture()
  }

  override fun handleSetRepeatMode(repeatMode: Int): ListenableFuture<*> {
    repeat = repeatMode
    return Futures.immediateVoidFuture()
  }

  override fun handleSetVolume(volume: Float): ListenableFuture<*> {
    this.volume = volume
    return Futures.immediateVoidFuture()
  }

  // ── engine events (main thread) ──────────────────────────────────────────

  override fun onSong(song: Engine.Song?) = invalidateState()

  override fun onAction(kind: String, detail: String) {
    onEngineAction(kind, detail)
    invalidateState()
  }

  companion object {
    private val COMMANDS = Player.Commands.Builder().addAll(
      Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE, Player.COMMAND_STOP, Player.COMMAND_RELEASE,
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
      Player.COMMAND_SEEK_TO_MEDIA_ITEM, Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
      Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS,
      Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA,
      Player.COMMAND_SET_REPEAT_MODE, Player.COMMAND_GET_VOLUME, Player.COMMAND_SET_VOLUME,
      Player.COMMAND_GET_AUDIO_ATTRIBUTES,
    ).build()
  }
}
