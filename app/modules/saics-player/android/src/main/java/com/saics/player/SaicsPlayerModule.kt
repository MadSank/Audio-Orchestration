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
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
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
      context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
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
                walkSaics(tree, id) { libraryJson = it; saicsRoot = rel }
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
      val tracks = files.sortedBy { it.first.lowercase() }.map { (path, uri) ->
        val m = meta[if (saicsRoot.isEmpty()) path else path.removePrefix("$saicsRoot/")]
        Track(uri.toString(), path.substringAfterLast('/').substringBeforeLast('.'), path,
              m?.first ?: "", m?.second ?: "original")
      }
      // The walk runs off the main thread, but the player may only be touched on its own.
      onService(promise) { svc ->
        svc.setLibrary(tracks)
        tracks.map { it.toMap() }
      }
    }

    // ── playback ──────────────────────────────────────────────────────────────
    AsyncFunction("startStation") { index: Int, promise: Promise ->
      onService(promise) { it.startStation(index, announce = true); null }
    }
    AsyncFunction("playTrack") { uri: String, promise: Promise ->
      onService(promise) { svc ->
        val all = svc.library
        val start = all.indexOfFirst { it.uri == uri }.coerceAtLeast(0)
        svc.player.setMediaItems(all.map { it.toMediaItem() }, start, 0)
        svc.player.prepare()
        svc.player.play()
        null
      }
    }
    AsyncFunction("togglePlay") { promise: Promise -> onService(promise) { it.togglePlay(); null } }
    AsyncFunction("next") { promise: Promise -> onService(promise) { it.next(hardCut = false); null } }
    AsyncFunction("previous") { promise: Promise -> onService(promise) { it.previous(); null } }
    AsyncFunction("toggleForever") { promise: Promise -> onService(promise) { it.toggleForever(); null } }
    AsyncFunction("toggleVinyl") { promise: Promise -> onService(promise) { it.toggleVinyl(); null } }
    AsyncFunction("getState") { promise: Promise -> onService(promise) { it.state() } }

    // ── Button test + settings ────────────────────────────────────────────────
    /** Simulates a helmet press (same path as a real key): button = PLAY_PAUSE|NEXT|PREVIOUS. */
    AsyncFunction("simulatePress") { button: String, promise: Promise ->
      onService(promise) { svc ->
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

  private fun walkSaics(tree: Uri, saicsId: String, found: (Uri) -> Unit) {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, saicsId)
    val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
    context.contentResolver.query(children, cols, null, null, null)?.use { c ->
      while (c.moveToNext()) {
        if (c.getString(1) == "library.json") found(DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0)))
      }
    }
  }

  /** file (relative) -> (group, version) from .saics/library.json. */
  private fun readLibrary(uri: Uri): Map<String, Pair<String, String>> = try {
    val text = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: "{}"
    val tracks = JSONObject(text).optJSONArray("tracks")
    val out = HashMap<String, Pair<String, String>>()
    if (tracks != null) {
      for (i in 0 until tracks.length()) {
        val t = tracks.getJSONObject(i)
        out[t.optString("file")] = t.optString("group") to t.optString("version", "original")
      }
    }
    out
  } catch (e: Exception) {
    emptyMap()
  }
}
