package com.saics.player

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.DocumentsContract
import android.provider.Settings
import android.view.KeyEvent
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

private const val PICK_FOLDER = 4711
private val AUDIO_EXT = setOf("mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav", "mpeg", "mp4")

/** JS bridge: folder access, library scan, playback controls, settings, Button test events. */
class SaicsPlayerModule : Module() {
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private var pickPromise: Promise? = null

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("no React context")

  private val prefs
    get() = context.getSharedPreferences(PlaybackService.PREFS, Context.MODE_PRIVATE)

  /** Binding a MediaController starts the service (Media3 makes it foreground when playing).
   *  [then] always runs on the main thread: AsyncFunctions are called on Expo's queue thread,
   *  and ExoPlayer may only be touched on its own (main) thread. */
  private fun ensureService(then: (PlaybackService) -> Unit) {
    val ready = PlaybackService.instance
    if (ready != null && controllerFuture != null) {
      context.mainExecutor.execute {
        attach(ready)
        then(ready)
      }
      return
    }
    val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
    val future = MediaController.Builder(context, token).buildAsync()
    controllerFuture = future
    future.addListener({
      val svc = PlaybackService.instance
      if (svc != null) {
        attach(svc)
        then(svc)
      }
    }, context.mainExecutor)
  }

  private fun attach(svc: PlaybackService) {
    svc.listener = { name, body -> sendEvent(name, body) }
  }

  private fun onService(promise: Promise, block: (PlaybackService) -> Any?) {
    ensureService { svc ->
      try {
        promise.resolve(block(svc))
      } catch (e: Exception) {
        promise.reject("ERR_SAICS", e.message, e)
      }
    }
  }

  /** A playback action from the app screen: it may start the phone speaker (testing at home);
   *  helmet keys, call-end focus regain and resumption never may (PlaybackService.guardSpeaker). */
  private fun onUiAction(promise: Promise, block: (PlaybackService) -> Any?) =
    onService(promise) { svc ->
      svc.allowSpeakerBriefly()
      block(svc)
    }

  override fun definition() = ModuleDefinition {
    Name("SaicsPlayer")
    Events("onButton", "onState", "onAction")

    OnCreate { ensureService {} }
    OnDestroy {
      PlaybackService.instance?.listener = null
      controllerFuture?.let { MediaController.releaseFuture(it) }
    }

    // ── music folder (Storage Access Framework, persisted permission) ─────────
    AsyncFunction("pickFolder") { promise: Promise ->
      val activity = appContext.currentActivity ?: return@AsyncFunction promise.reject("ERR_NO_ACTIVITY", "no activity", null)
      pickPromise = promise
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
      )
      activity.startActivityForResult(intent, PICK_FOLDER)
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != PICK_FOLDER) return@OnActivityResult
      val p = pickPromise ?: return@OnActivityResult
      pickPromise = null
      val uri = payload.data?.data
      if (payload.resultCode != Activity.RESULT_OK || uri == null) {
        p.resolve(null)
        return@OnActivityResult
      }
      // Write access is only used for the override files in .saics/ (hard rule 3).
      context.contentResolver.takePersistableUriPermission(
        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
      prefs.edit().putString("folder", uri.toString()).apply()
      p.resolve(uri.toString())
    }

    Function("getFolder") { prefs.getString("folder", null) }

    /** Lists audio files under the folder (skips _set_aside/ and .saics/), with song groups
     *  and versions from .saics/library.json when present; hands them to the player. */
    AsyncFunction("scanLibrary") { promise: Promise ->
      val folder = prefs.getString("folder", null) ?: return@AsyncFunction promise.resolve(emptyList<Map<String, Any?>>())
      val tree = Uri.parse(folder)
      val files = mutableListOf<Pair<String, Uri>>() // relative path, document uri
      var libraryJson: Uri? = null
      var bundles: Map<String, String> = emptyMap() // "<id>.json" -> document id in .saics/tracks
      var saicsDoc: String? = null
      var portalsUri: Uri? = null
      var saicsRoot = "" // library.json paths are relative to the folder that holds .saics/
      fun walk(docId: String, rel: String) {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        context.contentResolver.query(children, cols, null, null, null)?.use { c ->
          while (c.moveToNext()) {
            val id = c.getString(0)
            val name = c.getString(1) ?: continue
            val mime = c.getString(2) ?: ""
            val path = if (rel.isEmpty()) name else "$rel/$name"
            if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
              if (name == "_set_aside") continue
              if (name == ".saics") {
                saicsDoc = id
                portalsUri = children(tree, id)["portals.json"]?.let { DocumentsContract.buildDocumentUriUsingTree(tree, it) }
                walkSaics(tree, id, { libraryJson = it; saicsRoot = rel }) { bundles = it }
                continue
              }
              walk(id, path)
            } else if (name.substringAfterLast('.', "").lowercase() in AUDIO_EXT) {
              files.add(path to DocumentsContract.buildDocumentUriUsingTree(tree, id))
            }
          }
        }
      }
      walk(DocumentsContract.getTreeDocumentId(tree), "")
      val meta = libraryJson?.let { readLibrary(it) } ?: emptyMap()
      prefs.edit().putString("saicsDoc", saicsDoc).apply()
      val overrides = saicsDoc?.let { Overrides.read(context.contentResolver, tree, it) } ?: Overrides()
      val tracks = files.sortedBy { it.first.lowercase() }.map { (path, uri) ->
        val file = if (saicsRoot.isEmpty()) path else path.removePrefix("$saicsRoot/")
        val m = meta[file]
        val bundleDoc = m?.id?.let { bundles["$it.json"] }
        val facts = bundleDoc?.let { readFacts(tree, it) }
        val bundleUri = bundleDoc?.let { DocumentsContract.buildDocumentUriUsingTree(tree, it).toString() } ?: ""
        Track(uri.toString(), path.substringAfterLast('/').substringBeforeLast('.'), path,
              m?.group ?: "", m?.version ?: "original", facts?.gainDb ?: 0.0, bundleUri, m?.id ?: "", file,
              m?.groupName ?: "", facts?.bpm ?: 0.0, facts?.camelot ?: "", file in overrides.notLoopable)
      }.let { overrides.applyGroups(it) }
      // The walk runs off the main thread, but the player may only be touched on its own.
      onService(promise) { svc ->
        svc.setLibrary(tracks)
        svc.setPortals(portalsUri)
        tracks.map { it.toMap() }
      }
    }

    /** The library from the last scan (kept by the service), instantly; no folder walk. */
    AsyncFunction("getLibrary") { promise: Promise ->
      onService(promise) { svc -> svc.library.map { it.toMap() } }
    }

    // ── song groups review: override files in .saics/, applied here at once ───
    Function("canWriteOverrides") { canWrite() }
    AsyncFunction("setNotLoopable") { uri: String, value: Boolean, promise: Promise ->
      onService(promise) { svc ->
        val t = svc.library.firstOrNull { it.uri == uri } ?: return@onService false
        if (!Overrides.setNotLoopable(context.contentResolver, Uri.parse(prefs.getString("folder", null)), prefs.getString("saicsDoc", null), t.file, value)) return@onService false
        svc.updateTracks { l -> l.map { if (it.uri == uri) it.copy(notLoopable = value) else it } }
        svc.player.engine.setNotLoopable(uri, value)
        true
      }
    }
    /** Every version of group [from] joins group [into]. */
    AsyncFunction("mergeGroups") { from: String, into: String, promise: Promise ->
      onService(promise) { svc ->
        val target = svc.library.firstOrNull { it.group == into } ?: return@onService false
        val rows = svc.library.filter { it.group == from }.map { listOf("merge", it.file, target.file) }
        if (!Overrides.appendGroups(context.contentResolver, Uri.parse(prefs.getString("folder", null)), prefs.getString("saicsDoc", null), rows)) return@onService false
        svc.updateTracks { l -> l.map { if (it.group == from) it.copy(group = into, groupName = target.groupName) else it } }
        true
      }
    }
    /** One version leaves its group and becomes a song of its own. */
    AsyncFunction("splitTrack") { uri: String, promise: Promise ->
      onService(promise) { svc ->
        val t = svc.library.firstOrNull { it.uri == uri } ?: return@onService false
        if (!Overrides.appendGroups(context.contentResolver, Uri.parse(prefs.getString("folder", null)), prefs.getString("saicsDoc", null), listOf(listOf("split", t.file, "")))) return@onService false
        svc.updateTracks { l -> l.map { if (it.uri == uri) it.copy(group = "split:${it.file}", groupName = it.title) else it } }
        true
      }
    }
    AsyncFunction("stayPortal") { promise: Promise -> onService(promise) { it.player.engine.stay(); null } }
    AsyncFunction("getPortalsFrom") { trackId: String, promise: Promise ->
      onService(promise) { it.player.engine.portalsFrom(trackId) }
    }
    AsyncFunction("toggleLike") { uri: String, promise: Promise -> onService(promise) { it.toggleLike(uri); null } }
    AsyncFunction("pickVersion") { uri: String, promise: Promise -> onUiAction(promise) { it.pickVersion(uri); null } }

    // ── playback ──────────────────────────────────────────────────────────────
    AsyncFunction("startStation") { index: Int, promise: Promise ->
      onUiAction(promise) { it.startStation(index, announce = true); null }
    }
    AsyncFunction("playTrack") { uri: String, promise: Promise ->
      onUiAction(promise) { svc ->
        val all = svc.library
        val start = all.indexOfFirst { it.uri == uri }.coerceAtLeast(0)
        svc.player.engine.setMix(false, null) // a picked song: the queue plays in order
        svc.player.setMediaItems(all.map { it.toMediaItem() }, start, 0)
        svc.player.prepare()
        svc.player.play()
        null
      }
    }
    AsyncFunction("togglePlay") { promise: Promise -> onUiAction(promise) { it.togglePlay(); null } }
    AsyncFunction("next") { promise: Promise -> onUiAction(promise) { it.next(hardCut = false); null } }
    AsyncFunction("previous") { promise: Promise -> onUiAction(promise) { it.previous(); null } }
    AsyncFunction("toggleForever") { promise: Promise -> onService(promise) { it.toggleForever(); null } }
    AsyncFunction("toggleVinyl") { promise: Promise -> onService(promise) { it.toggleVinyl(); null } }
    AsyncFunction("getState") { promise: Promise -> onService(promise) { it.state() } }

    // ── Button test + settings ────────────────────────────────────────────────
    /** Simulates a helmet press (same path as a real key): button = PLAY_PAUSE|NEXT|PREVIOUS. */
    AsyncFunction("simulatePress") { button: String, promise: Promise ->
      onUiAction(promise) { svc ->
        val keyCode = when (button) {
          "NEXT" -> KeyEvent.KEYCODE_MEDIA_NEXT
          "PREVIOUS" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
          else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
        }
        svc.buttons.press(HelmetButtons.Button.valueOf(button), keyCode)
        null
      }
    }
    AsyncFunction("getButtonLog") { promise: Promise -> onService(promise) { it.buttonLog.toList() } }
    AsyncFunction("getSettings") { promise: Promise -> onService(promise) { it.settings() } }
    AsyncFunction("setSettings") { values: Map<String, Any?>, promise: Promise ->
      onService(promise) { it.applySettings(values); it.settings() }
    }
    AsyncFunction("speak") { text: String, promise: Promise -> onService(promise) { it.feedback.say(text); null } }

    // ── battery optimisation (OEM savers kill background audio) ──────────────
    Function("isIgnoringBatteryOptimizations") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(context.packageName)
    }
    Function("requestIgnoreBatteryOptimizations") {
      @Suppress("BatteryLife")
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
  }

  private fun children(tree: Uri, docId: String): Map<String, String> {
    val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
    val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
    val out = HashMap<String, String>()
    context.contentResolver.query(uri, cols, null, null, null)?.use { c ->
      while (c.moveToNext()) c.getString(1)?.let { out[it] = c.getString(0) }
    }
    return out
  }

  /** Finds .saics/library.json and the per-track bundles in .saics/tracks/. */
  private fun walkSaics(tree: Uri, saicsId: String, found: (Uri) -> Unit, tracks: (Map<String, String>) -> Unit) {
    val kids = children(tree, saicsId)
    kids["library.json"]?.let { found(DocumentsContract.buildDocumentUriUsingTree(tree, it)) }
    kids["tracks"]?.let { tracks(children(tree, it)) }
  }

  private data class Meta(val id: String, val group: String, val version: String, val groupName: String)
  private data class Facts(val gainDb: Double, val bpm: Double, val camelot: String)

  private fun canWrite(): Boolean {
    val folder = prefs.getString("folder", null) ?: return false
    return context.contentResolver.persistedUriPermissions.any { it.uri.toString() == folder && it.isWritePermission }
  }

  /** file (relative to the folder holding .saics) -> bundle id, group, version from library.json. */
  private fun readLibrary(uri: Uri): Map<String, Meta> = try {
    val text = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: "{}"
    val lib = JSONObject(text)
    val tracks = lib.optJSONArray("tracks")
    val groups = lib.optJSONObject("groups")
    val out = HashMap<String, Meta>()
    if (tracks != null) {
      for (i in 0 until tracks.length()) {
        val t = tracks.getJSONObject(i)
        val g = t.optString("group")
        out[t.optString("file")] = Meta(t.optString("id"), g, t.optString("version", "original"), groups?.optJSONObject(g)?.optString("name") ?: "")
      }
    }
    out
  } catch (e: Exception) {
    emptyMap()
  }

  /** Loudness, tempo and key from a track's analysis bundle; null when unreadable. */
  private fun readFacts(tree: Uri, docId: String): Facts? = try {
    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
    val text = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: "{}"
    val o = JSONObject(text)
    Facts(o.optJSONObject("loudness")?.optDouble("gain_db", 0.0) ?: 0.0, o.optJSONObject("tempo")?.optDouble("bpm", 0.0) ?: 0.0,
      o.optJSONObject("key")?.optString("camelot", "") ?: "")
  } catch (e: Exception) {
    null
  }
}
