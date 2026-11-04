package com.saics.player

import android.app.PendingIntent
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.saics.player.engine.Engine
import com.saics.player.engine.SaicsPlayer
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
  val bundle: String = "", // document uri of its .saics/tracks/<id>.json ("" = none)
  val trackId: String = "", // bundle id ("" = not analysed)
  val file: String = "", // relative to the folder holding .saics (the key in override files)
  val groupName: String = "",
  val bpm: Double = 0.0,
  val camelot: String = "",
  val notLoopable: Boolean = false,
) {
  fun toSong() = Engine.Song(
    uri, Uri.parse(uri), bundle.takeIf { it.isNotEmpty() }?.let { Uri.parse(it) }, title, group, version, gainDb,
    trackId, notLoopable,
  )

  fun toJson(): JSONObject = JSONObject()
    .put("uri", uri).put("title", title).put("path", path).put("group", group).put("version", version)
    .put("gainDb", gainDb).put("bundle", bundle).put("trackId", trackId).put("file", file)
    .put("groupName", groupName).put("bpm", bpm).put("camelot", camelot).put("notLoopable", notLoopable)

  fun toMediaItem(): MediaItem = MediaItem.Builder()
    .setMediaId(uri)
    .setUri(Uri.parse(uri))
    .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(Uri.parse(uri)).build())
    .setMediaMetadata(
      MediaMetadata.Builder().setTitle(title).setSubtitle(version).setIsPlayable(true).build(),
    )
    .build()

  fun toMap(): Map<String, Any?> =
    mapOf("uri" to uri, "title" to title, "path" to path, "group" to group, "version" to version, "gainDb" to gainDb, "bundle" to bundle,
          "trackId" to trackId, "file" to file, "groupName" to groupName, "bpm" to bpm, "camelot" to camelot,
          "notLoopable" to notLoopable)

  companion object {
    fun fromJson(o: JSONObject) = Track(
      o.getString("uri"), o.optString("title"), o.optString("path"),
      o.optString("group"), o.optString("version", "original"), o.optDouble("gainDb", 0.0),
      o.optString("bundle", ""), o.optString("trackId", ""), o.optString("file", ""),
      o.optString("groupName", ""), o.optDouble("bpm", 0.0), o.optString("camelot", ""),
      o.optBoolean("notLoopable", false),
    )
  }
}

/**
 * The media service the Cardo talks to: the SAICS engine (P6: Forever jumps, live Vinyl,
 * version switches) behind a Media3 session, with the helmet button mapping, audio feedback,
 * audio focus (duck for navigation prompts, pause/resume for calls), pause on Bluetooth
 * disconnect, never the phone speaker, and playback resumption.
 */
class PlaybackService : MediaLibraryService() {
  lateinit var player: SaicsPlayer
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
    player = SaicsPlayer(this).also { p ->
      p.resolve = { item ->
        library.firstOrNull { it.uri == item.mediaId }?.toSong()
          ?: Track(item.mediaId, item.mediaMetadata.title?.toString() ?: "", "", "", "").toSong()
      }
      p.itemFor = { song -> library.firstOrNull { it.uri == song.id }?.toMediaItem() }
      p.onEngineAction = ::onEngineAction
    }
    feedback = Feedback(this) { duck -> player.engine.duck(if (duck) 0.3f else 1f) }
    buttons = HelmetButtons(::onButton) { ev ->
      buttonLog.addFirst(ev)
      while (buttonLog.size > 100) buttonLog.removeLast()
      emit("onButton", ev)
    }
    loadSettings()
    player.engine.setLibrary(library.map { it.toSong() })
    player.engine.setForever(forever)
    player.engine.setVinyl(vinyl)
    player.engine.setVinylComp(VINYL_COMP_DB)
    prefs.getString("portals", null)?.let { player.engine.setPortals(Uri.parse(it)) }
    player.addListener(object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        saveState()
        emitState()
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) guardSpeaker()
        saveState()
        emitState()
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

  /** `adb shell dumpsys activity service com.saics.app/com.saics.player.PlaybackService` */
  override fun dump(fd: java.io.FileDescriptor?, writer: java.io.PrintWriter, args: Array<out String>?) {
    writer.println(player.engine.dump())
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Swiping the app away must not stop a ride; only stop when nothing is playing.
    if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
  }

  override fun onDestroy() {
    saveState()
    audio.unregisterAudioDeviceCallback(deviceCallback)
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
    if (player.playWhenReady) {
      player.pause() // the engine fades out over 100 ms
    } else {
      if (player.mediaItemCount == 0) restoreQueue()
      if (player.mediaItemCount == 0 && library.isNotEmpty()) startStation(station, announce = false)
      player.prepare()
      player.play()
    }
  }

  /** Next x1: in Forever another version of the song (on the next bar), else the next portal.
   *  Next x2: a completely different song, in Forever too (Forever stays on and loops it). */
  fun next(hardCut: Boolean) {
    player.engine.next(hardCut)
    feedback.earcon("step")
    if (hardCut) main.postDelayed({ feedback.earcon("step") }, 120) // the spec's double tick
    if (announceTitles && !forever) main.postDelayed({ feedback.say("Next: ${currentTrack()?.title ?: ""}") }, 2500)
    emit("onAction", mapOf("action" to if (hardCut) "cut" else "next"))
  }

  fun previous() {
    player.engine.previous()
    feedback.earcon("step")
    emit("onAction", mapOf("action" to "previous"))
  }

  /** What the engine did, for spoken feedback and the app. */
  private fun onEngineAction(kind: String, detail: String) {
    when (kind) {
      "version" -> if (!detail.endsWith("(song end)")) feedback.say(detail.replace('_', ' '))
      "error" -> feedback.confirm("error", detail)
    }
    emit("onAction", mapOf("action" to kind, "detail" to detail))
    saveState()
    emitState()
  }

  fun toggleForever() {
    forever = !forever
    player.engine.setForever(forever)
    feedback.confirm(if (forever) "on" else "off", if (forever) "Forever on" else "Forever off")
    saveSettings()
    emitState()
  }

  fun toggleVinyl() {
    vinyl = !vinyl
    player.engine.setVinyl(vinyl) // switches on the next bar, 200 ms crossfade
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
    if (index == 1) {
      vinyl = true
      player.engine.setVinyl(true)
    }
    val pool = when (index) {
      2 -> library.filter { "slowed" in it.version }.ifEmpty { library } // Late Night
      3 -> library.filter { it.uri in liked }.ifEmpty { library } // Liked
      else -> library
    }.let { songs -> songs.filter { it.trackId.isNotEmpty() }.ifEmpty { songs } } // analysed songs only
      .let { songs -> songs.filterNot { "lofi vhs" in it.file.lowercase() }.ifEmpty { songs } } // pickable, never walked
    val byGroup = pool.groupBy { it.group.ifEmpty { it.uri } }
    val queue = byGroup.values.shuffled().map { versions ->
      versions.firstOrNull { it.version == "original" && index != 2 }.takeIf { Math.random() < 0.5 } ?: versions.random()
    }
    if (queue.isEmpty()) {
      feedback.confirm("error", "No songs. Pick your music folder in the app.")
      return
    }
    player.engine.setMix(true, pool.map { it.trackId }.filter { it.isNotEmpty() }.toSet())
    player.setMediaItems(queue.map { it.toMediaItem() })
    player.prepare()
    player.play()
    if (announce) feedback.confirm("step", STATIONS[index])
    saveSettings()
    saveState()
    emitState()
  }

  fun currentTrack(): Track? {
    val s = player.engine.current ?: return null
    return library.firstOrNull { it.uri == s.id } ?: Track(s.id, s.title, "", s.group, s.version)
  }

  fun state(): Map<String, Any?> {
    val t = currentTrack()
    return mapOf(
      "isPlaying" to player.isPlaying, "title" to t?.title, "version" to t?.version, "group" to t?.group,
      "forever" to forever, "vinyl" to vinyl, "station" to STATIONS[station], "stationIndex" to station,
      "queueLength" to player.mediaItemCount, "position" to player.engine.positionMs(), "duration" to player.engine.durationMs(),
      "libraryCount" to library.size,
      "liked" to (t != null && t.uri in liked),
      "versionIndex" to versions.indexOfFirst { it.uri == t?.uri } + 1, "versionCount" to versions.size,
      "versions" to versions.map { mapOf("uri" to it.uri, "title" to it.title, "version" to it.version) },
    ) + player.engine.status()
  }

  /** Other versions of the playing song, in library order (itself included). */
  private val versions: List<Track>
    get() {
      val t = currentTrack() ?: return emptyList()
      return if (t.group.isEmpty()) listOf(t) else library.filter { it.group == t.group }.ifEmpty { listOf(t) }
    }

  // ── likes (helmet-free, app screen only for now) ────────────────────────────

  var liked: Set<String> = emptySet()
    private set

  fun toggleLike(uri: String) {
    liked = if (uri in liked) liked - uri else liked + uri
    prefs.edit().putStringSet("liked", liked).apply()
    emitState()
  }

  /** `.saics/portals.json`, found by the scan. */
  fun setPortals(uri: Uri?) {
    prefs.edit().putString("portals", uri?.toString()).apply()
    player.engine.setPortals(uri)
  }

  fun pickVersion(uri: String) = library.firstOrNull { it.uri == uri }?.let { player.engine.switchVersionTo(it.toSong()) }

  /** Group merge/split or a not-loopable change, in memory (the module writes the override file). */
  fun updateTracks(change: (List<Track>) -> List<Track>) = setLibrary(change(library))

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

  // ── persistence (playback resumption) ───────────────────────────────────────

  fun setLibrary(tracks: List<Track>) {
    library = tracks
    player.engine.setLibrary(tracks.map { it.toSong() })
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
    liked = prefs.getStringSet("liked", emptySet())?.toSet() ?: emptySet()
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
    /** Vinyl chain loudness compensation (D18): measured offline against versions.py. */
    const val VINYL_COMP_DB = 3.0 // vinyl is -3.0 LU on average (12 library songs, sd 1.0)
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
