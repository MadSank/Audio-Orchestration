package com.saics.player

import android.app.PendingIntent
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.LoudnessEnhancer
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject

/** One playable song from the music folder (plus its song group / version from .saics). */
data class Track(
  val uri: String,
  val title: String,
  val path: String,
  val group: String,
  val version: String,
  val gainDb: Double = 0.0, // to -14 LUFS, from the track's analysis bundle (0 when missing)
) {
  fun toJson(): JSONObject = JSONObject()
    .put("uri", uri).put("title", title).put("path", path).put("group", group).put("version", version)
    .put("gainDb", gainDb)

  fun toMediaItem(): MediaItem = MediaItem.Builder()
    .setMediaId(uri)
    .setUri(Uri.parse(uri))
    .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(Uri.parse(uri)).build())
    .setMediaMetadata(
      MediaMetadata.Builder().setTitle(title).setSubtitle(version).setIsPlayable(true).build(),
    )
    .build()

  fun toMap(): Map<String, Any?> =
    mapOf("uri" to uri, "title" to title, "path" to path, "group" to group, "version" to version, "gainDb" to gainDb)

  companion object {
    fun fromJson(o: JSONObject) = Track(
      o.getString("uri"), o.optString("title"), o.optString("path"),
      o.optString("group"), o.optString("version", "original"), o.optDouble("gainDb", 0.0),
    )
  }
}

/**
 * The media service the Cardo talks to. Milestone A (P5): plain ExoPlayer playback of the
 * library, with the helmet button mapping, audio feedback, audio focus (duck for navigation
 * prompts, pause/resume for calls), pause on Bluetooth disconnect, and playback resumption.
 */
class PlaybackService : MediaLibraryService() {
  lateinit var player: ExoPlayer
  lateinit var buttons: HelmetButtons
  lateinit var feedback: Feedback
  private var session: MediaLibrarySession? = null
  private val main = Handler(Looper.getMainLooper())

  var library: List<Track> = emptyList()
    private set
  var forever = false
  var vinyl = false
  var station = 0
  var announceTitles = false
  val buttonLog = ArrayDeque<Map<String, Any?>>()
  var listener: ((String, Map<String, Any?>) -> Unit)? = null

  private var fadeLevel = 1f
  private var duckLevel = 1f
  private var gainLevel = 1f // loudness normalisation: attenuation part (boosts go to the enhancer)
  private var enhancer: LoudnessEnhancer? = null
  private val audio by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }

  /** Playback started from the app screen may use the phone speaker (owner testing at home);
   *  anything else (helmet keys, focus regain after a call, resumption) never may. */
  private var uiPlayUntil = 0L
  fun allowSpeakerBriefly() {
    uiPlayUntil = SystemClock.elapsedRealtime() + 3000
  }
  private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }

  override fun onCreate() {
    super.onCreate()
    player = ExoPlayer.Builder(this)
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        /* handleAudioFocus = */ true, // ducks under navigation prompts, pauses for calls
      )
      .setHandleAudioBecomingNoisy(true) // helmet off / out of range: pause, never the speaker
      .setWakeMode(C.WAKE_MODE_LOCAL)
      .build()
    feedback = Feedback(this) { duck ->
      duckLevel = if (duck) 0.3f else 1f
      applyVolume()
    }
    buttons = HelmetButtons(::onButton) { ev ->
      buttonLog.addFirst(ev)
      while (buttonLog.size > 100) buttonLog.removeLast()
      emit("onButton", ev)
    }
    loadSettings()
    player.addListener(object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        applyGain()
        saveState()
        emitState()
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) guardSpeaker()
        saveState()
        emitState()
      }

      override fun onAudioSessionIdChanged(audioSessionId: Int) {
        enhancer?.release()
        enhancer = null
        applyGain()
      }
    })
    audio.registerAudioDeviceCallback(deviceCallback, main)
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val builder = MediaLibrarySession.Builder(this, player, Callback())
    if (launch != null) {
      builder.setSessionActivity(
        PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
      )
    }
    session = builder.build()
    instance = this
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping the app away must not stop a ride; only stop when nothing is playing.
    if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
  }

  override fun onDestroy() {
    saveState()
    audio.unregisterAudioDeviceCallback(deviceCallback)
    enhancer?.release()
    session?.run {
      player.release()
      release()
    }
    session = null
    feedback.release()
    instance = null
    super.onDestroy()
  }

  // ── helmet actions (PLAN.md button mapping) ──────────────────────────────────

  private fun onButton(button: HelmetButtons.Button, count: Int) {
    when (button) {
      HelmetButtons.Button.PLAY_PAUSE -> when (count) {
        1 -> togglePlay()
        2 -> toggleVinyl()
        else -> cycleStation()
      }
      HelmetButtons.Button.NEXT -> if (count >= 2) next(hardCut = true) else next(hardCut = false)
      HelmetButtons.Button.PREVIOUS -> if (count >= 2) toggleForever() else previous()
    }
  }

  fun togglePlay() {
    if (player.isPlaying) {
      fadeTo(0f, 100) { player.pause() }
    } else {
      if (player.mediaItemCount == 0) restoreQueue()
      if (player.mediaItemCount == 0 && library.isNotEmpty()) startStation(station, announce = false)
      if (player.playbackState == Player.STATE_IDLE) player.prepare()
      fadeLevel = 0f
      applyVolume()
      player.play()
      fadeTo(1f, 100) {}
    }
  }

  fun next(hardCut: Boolean) {
    if (forever) {
      switchVersion()
      return
    }
    if (player.hasNextMediaItem()) player.seekToNextMediaItem() else if (player.mediaItemCount > 0) player.seekTo(0, 0)
    feedback.earcon("step")
    if (announceTitles) feedback.say("Next: ${currentTrack()?.title ?: ""}")
    emit("onAction", mapOf("action" to if (hardCut) "cut" else "next"))
  }

  fun previous() {
    if (player.currentPosition > 5000 || !player.hasPreviousMediaItem()) player.seekTo(0) else player.seekToPreviousMediaItem()
    feedback.earcon("step")
    emit("onAction", mapOf("action" to "previous"))
  }

  fun toggleForever() {
    forever = !forever
    player.repeatMode = if (forever) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_ALL
    feedback.confirm(if (forever) "on" else "off", if (forever) "Forever on" else "Forever off")
    saveSettings()
    emitState()
  }

  fun toggleVinyl() {
    vinyl = !vinyl // audio effect arrives with the native engine (P6)
    feedback.confirm(if (vinyl) "on" else "off", if (vinyl) "Vinyl on" else "Vinyl off")
    saveSettings()
    emitState()
  }

  fun cycleStation() {
    station = (station + 1) % STATIONS.size
    startStation(station, announce = true)
  }

  /** Builds the station's queue (two-stage shuffle: one version per song group) and plays. */
  fun startStation(index: Int, announce: Boolean) {
    station = index
    if (index == 1) vinyl = true
    val pool = when (index) {
      2 -> library.filter { "slowed" in it.version }.ifEmpty { library } // Late Night
      else -> library
    }
    val byGroup = pool.groupBy { it.group.ifEmpty { it.uri } }
    val queue = byGroup.values.shuffled().map { versions ->
      versions.firstOrNull { it.version == "original" && index != 2 }.takeIf { Math.random() < 0.5 } ?: versions.random()
    }
    if (queue.isEmpty()) {
      feedback.confirm("error", "No songs. Pick your music folder in the app.")
      return
    }
    player.setMediaItems(queue.map { it.toMediaItem() })
    player.repeatMode = if (forever) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_ALL
    player.prepare()
    player.play()
    if (announce) feedback.confirm("step", STATIONS[index])
    saveSettings()
    saveState()
    emitState()
  }

  /** Forever + Next: another version of the same song group (plain cut in milestone A). */
  private fun switchVersion() {
    val cur = currentTrack() ?: return
    val others = library.filter { it.group.isNotEmpty() && it.group == cur.group && it.uri != cur.uri }
    if (others.isEmpty()) {
      feedback.confirm("error", "No other version")
      return
    }
    val pick = others.random()
    val idx = player.currentMediaItemIndex
    player.addMediaItem(idx + 1, pick.toMediaItem())
    player.seekToNextMediaItem()
    feedback.confirm("step", pick.version)
    emit("onAction", mapOf("action" to "version", "version" to pick.version))
  }

  fun currentTrack(): Track? {
    val id = player.currentMediaItem?.mediaId ?: return null
    return library.firstOrNull { it.uri == id }
      ?: player.currentMediaItem?.mediaMetadata?.title?.let { Track(id, it.toString(), "", "", "") }
  }

  fun state(): Map<String, Any?> {
    val t = currentTrack()
    return mapOf(
      "isPlaying" to player.isPlaying, "title" to t?.title, "version" to t?.version, "group" to t?.group,
      "forever" to forever, "vinyl" to vinyl, "station" to STATIONS[station], "stationIndex" to station,
      "queueLength" to player.mediaItemCount, "position" to player.currentPosition, "duration" to player.duration,
      "libraryCount" to library.size,
    )
  }

  // ── volume ───────────────────────────────────────────────────────────────────

  private fun applyVolume() {
    player.volume = fadeLevel * duckLevel * gainLevel
  }

  /** Normalise the current track to -14 LUFS: cut with the player volume, boost (max +10 dB)
   *  with a LoudnessEnhancer on the player's audio session. */
  private fun applyGain() {
    val g = (currentTrack()?.gainDb ?: 0.0).coerceIn(-30.0, MAX_BOOST_DB)
    gainLevel = if (g < 0) Math.pow(10.0, g / 20).toFloat() else 1f
    applyVolume()
    val boostMb = if (g > 0) (g * 100).toInt() else 0
    try {
      if (boostMb > 0 && enhancer == null && player.audioSessionId != C.AUDIO_SESSION_ID_UNSET) {
        enhancer = LoudnessEnhancer(player.audioSessionId)
      }
      enhancer?.setTargetGain(boostMb)
      enhancer?.enabled = boostMb > 0
    } catch (e: RuntimeException) {
      enhancer = null // effect unavailable on this device: attenuation still applies
    }
  }

  // ── never the phone speaker (Bluetooth drop, call end, resumption) ──────────

  private fun hasPrivateOutput(): Boolean = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
    it.type in PRIVATE_OUTPUTS
  }

  private fun guardSpeaker() {
    if (hasPrivateOutput() || SystemClock.elapsedRealtime() < uiPlayUntil) return
    player.pause()
    emit("onAction", mapOf("action" to "speaker-blocked"))
  }

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
      // Helmet off or out of range: pause (becoming-noisy also does this; belt and braces).
      if (removed.any { it.type in PRIVATE_OUTPUTS } && !hasPrivateOutput() && player.isPlaying) player.pause()
    }
  }

  private fun fadeTo(target: Float, ms: Long, done: () -> Unit) {
    val steps = 10
    val start = fadeLevel
    for (i in 1..steps) {
      main.postDelayed({
        fadeLevel = start + (target - start) * i / steps
        applyVolume()
        if (i == steps) done()
      }, ms * i / steps)
    }
  }

  // ── persistence (playback resumption) ───────────────────────────────────────

  fun setLibrary(tracks: List<Track>) {
    library = tracks
    prefs.edit().putString("library", JSONArray(tracks.map { it.toJson() }).toString()).apply()
    emitState()
  }

  private fun saveState() {
    val items = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
    prefs.edit()
      .putString("queue", JSONArray(items).toString())
      .putInt("index", player.currentMediaItemIndex)
      .putLong("position", player.currentPosition)
      .apply()
  }

  private fun saveSettings() {
    prefs.edit()
      .putBoolean("forever", forever).putBoolean("vinyl", vinyl).putInt("station", station)
      .putBoolean("tts", feedback.speech).putBoolean("earcons", feedback.earcons)
      .putBoolean("announceTitles", announceTitles)
      .putLong("multiWindowMs", buttons.multiWindowMs).putLong("tripleWindowMs", buttons.tripleWindowMs)
      .apply()
  }

  fun applySettings(map: Map<String, Any?>) {
    (map["tts"] as? Boolean)?.let { feedback.speech = it }
    (map["earcons"] as? Boolean)?.let { feedback.earcons = it }
    (map["announceTitles"] as? Boolean)?.let { announceTitles = it }
    (map["multiWindowMs"] as? Number)?.let { buttons.multiWindowMs = it.toLong().coerceIn(200, 2000) }
    (map["tripleWindowMs"] as? Number)?.let { buttons.tripleWindowMs = it.toLong().coerceIn(300, 3000) }
    saveSettings()
  }

  fun settings(): Map<String, Any?> = mapOf(
    "tts" to feedback.speech, "earcons" to feedback.earcons, "announceTitles" to announceTitles,
    "multiWindowMs" to buttons.multiWindowMs, "tripleWindowMs" to buttons.tripleWindowMs,
  )

  private fun loadSettings() {
    forever = prefs.getBoolean("forever", false)
    vinyl = prefs.getBoolean("vinyl", false)
    station = prefs.getInt("station", 0)
    feedback.speech = prefs.getBoolean("tts", true)
    feedback.earcons = prefs.getBoolean("earcons", true)
    announceTitles = prefs.getBoolean("announceTitles", false)
    buttons.multiWindowMs = prefs.getLong("multiWindowMs", 700)
    buttons.tripleWindowMs = prefs.getLong("tripleWindowMs", 1000)
    library = try {
      val arr = JSONArray(prefs.getString("library", "[]"))
      (0 until arr.length()).map { Track.fromJson(arr.getJSONObject(it)) }
    } catch (e: Exception) {
      emptyList()
    }
  }

  private fun savedQueue(): Triple<List<MediaItem>, Int, Long> {
    val ids = try {
      val arr = JSONArray(prefs.getString("queue", "[]"))
      (0 until arr.length()).map { arr.getString(it) }
    } catch (e: Exception) {
      emptyList()
    }
    val byUri = library.associateBy { it.uri }
    val items = ids.map { id -> byUri[id]?.toMediaItem() ?: Track(id, id.substringAfterLast("%2F"), "", "", "").toMediaItem() }
    return Triple(items, prefs.getInt("index", 0).coerceIn(0, maxOf(0, items.size - 1)), prefs.getLong("position", 0))
  }

  private fun restoreQueue() {
    val (items, index, pos) = savedQueue()
    if (items.isEmpty()) return
    player.setMediaItems(items, index, pos)
    player.repeatMode = if (forever) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_ALL
    player.prepare()
  }

  // ── events to JS ─────────────────────────────────────────────────────────────

  fun emit(name: String, body: Map<String, Any?>) {
    main.post { listener?.invoke(name, body) }
  }

  fun emitState() = emit("onState", state())

  inner class Callback : MediaLibrarySession.Callback {
    override fun onMediaButtonEvent(
      session: MediaSession,
      controllerInfo: MediaSession.ControllerInfo,
      intent: Intent,
    ): Boolean {
      @Suppress("DEPRECATION")
      val event = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return false
      return buttons.onKeyEvent(event) // our mapping, not the framework default
    }

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      val root = MediaItem.Builder().setMediaId("root")
        .setMediaMetadata(MediaMetadata.Builder().setTitle("SAICS").setIsBrowsable(true).setIsPlayable(false).build())
        .build()
      return Futures.immediateFuture(LibraryResult.ofItem(root, params))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val stations = STATIONS.mapIndexed { i, name ->
        MediaItem.Builder().setMediaId("station:$i")
          .setMediaMetadata(MediaMetadata.Builder().setTitle(name).setIsBrowsable(false).setIsPlayable(true).build())
          .build()
      }
      val items = if (parentId == "root") stations else emptyList()
      return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(items), params))
    }

    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      val first = mediaItems.firstOrNull()?.mediaId
      if (first != null && first.startsWith("station:")) { // Android Auto / voice: a station
        main.post { startStation(first.removePrefix("station:").toIntOrNull() ?: 0, announce = true) }
        return Futures.immediateFuture(mutableListOf())
      }
      val resolved = mediaItems.map { item ->
        val uri = item.requestMetadata.mediaUri ?: item.localConfiguration?.uri ?: Uri.parse(item.mediaId)
        item.buildUpon().setUri(uri).build()
      }
      return Futures.immediateFuture(resolved.toMutableList())
    }

    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val (items, index, pos) = savedQueue()
      if (items.isEmpty() && library.isNotEmpty()) {
        val queue = library.shuffled().map { it.toMediaItem() }
        return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(queue, 0, 0))
      }
      return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(items, index, pos))
    }
  }

  companion object {
    const val PREFS = "saics-player"
    const val MAX_BOOST_DB = 10.0
    private val PRIVATE_OUTPUTS = setOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_HEARING_AID,
    )
    val STATIONS = listOf("Infinite Ride", "Vinyl Ride", "Late Night", "Liked")

    @Volatile
    var instance: PlaybackService? = null
  }
}
