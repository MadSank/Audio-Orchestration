package com.saics.player

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.provider.MediaStore
import com.saics.player.engine.Decoder
import com.saics.player.engine.ENGINE_RATE
import com.saics.player.engine.Lite
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Songs the laptop hasn't analysed yet get a Forever bundle on the phone (engine/saics/lite.py).
 * It finds them in the music folder and in Download, one at a time on a background thread, and
 * keeps its bundles in the app's own storage: the audio and `.saics/` are never touched. A song
 * that later arrives with a laptop bundle uses that one instead.
 */
class LiteAnalyzer(private val context: Context, private val onChanged: () -> Unit) {
  private val dir = File(context.filesDir, "lite").apply { mkdirs() }
  private val indexFile = File(dir, "index.json")
  private val main = Handler(Looper.getMainLooper())
  private val thread = HandlerThread("saics-lite", Process.THREAD_PRIORITY_BACKGROUND).apply { start() }
  private val work = Handler(thread.looper)
  private val index: JSONObject = try {
    JSONObject(indexFile.readText())
  } catch (e: Exception) {
    JSONObject()
  }
  private val queued = HashSet<String>()
  private val trace = ArrayDeque<String>()
  private var observer: ContentObserver? = null
  private val scan = Runnable { onChanged() }

  @Volatile var current: String? = null
    private set
  @Volatile var pending = 0
    private set

  private fun log(msg: String) = synchronized(trace) {
    trace.addLast(msg)
    while (trace.size > 40) trace.removeFirst()
  }

  fun dump(): String = "lite: queue=$pending current=$current index=${index.length()}\n" + synchronized(trace) { trace.joinToString("\n") }

  /** Watches the media library, so that a finished download starts its analysis. */
  fun start() {
    if (observer != null) return
    observer = object : ContentObserver(main) {
      override fun onChange(selfChange: Boolean) {
        main.removeCallbacks(scan)
        main.postDelayed(scan, SETTLE_MS) // a download changes the entry many times
      }
    }.also { context.contentResolver.registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, it) }
  }

  fun release() {
    observer?.let { context.contentResolver.unregisterContentObserver(it) }
    observer = null
    main.removeCallbacks(scan)
    thread.quitSafely()
  }

  private fun canReadMedia(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
    context.checkSelfPermission(Manifest.permission.READ_MEDIA_AUDIO) == PackageManager.PERMISSION_GRANTED

  /** Audio in Download of a song's length. Not the music folder (the scan has it) nor recordings. */
  private fun downloads(): List<Track> {
    if (!canReadMedia()) return emptyList()
    val uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
    val cols = arrayOf(
      MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DISPLAY_NAME,
      MediaStore.Audio.Media.RELATIVE_PATH, MediaStore.Audio.Media.DURATION,
    )
    val out = ArrayList<Track>()
    context.contentResolver.query(uri, cols, "${MediaStore.Audio.Media.RELATIVE_PATH} LIKE ?", arrayOf("Download/%"), null)?.use { c ->
      while (c.moveToNext()) {
        val name = c.getString(1) ?: continue
        val ms = c.getLong(3)
        if (ms < MIN_MS || ms > MAX_MS) continue
        val path = (c.getString(2) ?: "") + name
        out.add(Track(ContentUris.withAppendedId(uri, c.getLong(0)).toString(), name.substringBeforeLast('.'), path, "", "original", file = name))
      }
    }
    return out
  }

  private fun nameOf(t: Track) = t.path.substringAfterLast('/')

  /** The library plus Download, with what's been analysed here. Queues whatever has no bundle. */
  fun merge(base: List<Track>): List<Track> {
    // Download's songs come fresh from the media library, so that deleted ones go.
    val folder = base.filterNot { it.uri.startsWith(MEDIA_URI) }
    val names = folder.map { nameOf(it) }.toHashSet()
    val all = folder + downloads().filter { nameOf(it) !in names }
    val merged = all.map { t ->
      val e = if (t.trackId.isEmpty()) index.optJSONObject(nameOf(t)) else null
      if (e == null || !e.has("bundle")) t else t.copy(
        gainDb = e.getDouble("gain_db"), bundle = Uri.fromFile(File(dir, e.getString("bundle"))).toString(),
        trackId = e.getString("id"), bpm = e.getDouble("bpm"),
      )
    }
    for (t in merged) {
      val name = nameOf(t)
      if (t.trackId.isEmpty() && canTry(name) && queued.add(name)) {
        pending++
        work.post { analyse(t, name) }
      }
    }
    return merged
  }

  /** Not done, and hasn't taken the app down twice: music comes before analysis. */
  private fun canTry(name: String): Boolean {
    val e = index.optJSONObject(name) ?: return true
    return e.length() == 1 && e.optInt("attempts") in 1 until MAX_ATTEMPTS
  }

  private fun put(name: String, entry: JSONObject) {
    index.put(name, entry)
    indexFile.writeText(index.toString())
  }

  private fun analyse(t: Track, name: String) {
    current = t.title
    val t0 = SystemClock.elapsedRealtime()
    // Written first: a native crash here takes the process down before any catch can run.
    put(name, JSONObject().put("attempts", (index.optJSONObject(name)?.optInt("attempts") ?: 0) + 1))
    try {
      // Before decoding: a whole hour-long file would take the memory the music needs.
      val known = MediaMetadataRetriever().run {
        try {
          setDataSource(context, Uri.parse(t.uri))
          extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        } finally {
          release()
        }
      }
      if (known != null && known > MAX_MS) {
        put(name, JSONObject().put("skipped", "length ${known / 1000} s"))
        log("$name: skipped, ${known / 1000} s")
        current = null
        pending--
        return
      }
      val opened = Decoder.open(context, Uri.parse(t.uri)) ?: throw IllegalStateException("won't open")
      val (pcm, job) = opened
      job()
      val frames = pcm.frames
      val duration = frames.toDouble() / ENGINE_RATE
      if (pcm.failed || duration * 1000 < MIN_MS || duration * 1000 > MAX_MS) {
        put(name, JSONObject().put("skipped", "length ${duration.toInt()} s"))
        log("$name: skipped, ${duration.toInt()} s")
      } else {
        val mono = FloatArray(frames) { (pcm.left(it) + pcm.right(it)) / 2 }
        val y22 = Lite.halve(mono)
        val spect = Lite.logMel(y22)
        val t1 = SystemClock.elapsedRealtime()
        val (bl, dl) = withModel { run -> Lite.framesToLogits(spect, run) }
        val t2 = SystemClock.elapsedRealtime()
        val (beats, raw) = Lite.beatsFromLogits(bl, dl)
        val result = Lite.analyse(y22, duration, beats, raw)
        val lufs = Lite.integratedLufs(frames, { pcm.left(it) }, { pcm.right(it) })
        val id = "phone-" + Integer.toHexString(name.hashCode())
        File(dir, "$id.json").writeText(Lite.toJson(result, lufs, duration))
        val bpm = JSONObject(Lite.toJson(result, lufs, duration)).getJSONObject("tempo").getDouble("bpm")
        put(name, JSONObject().put("bundle", "$id.json").put("id", id).put("gain_db", -14.0 - lufs).put("bpm", bpm))
        log(
          "$name: ${duration.toInt()} s of audio in ${(SystemClock.elapsedRealtime() - t0) / 1000.0} s " +
            "(mel ${(t1 - t0) / 1000.0}, model ${(t2 - t1) / 1000.0}): ${beats.size} beats, " +
            "${result.downbeats.size} bars, ${result.sections.size} sections, ${result.jumps.size} jumps, %.1f LUFS".format(lufs),
        )
        main.post(onChanged)
      }
    } catch (e: Exception) {
      put(name, JSONObject().put("failed", e.toString()))
      log("$name: failed: $e")
    } catch (e: OutOfMemoryError) {
      log("$name: out of memory; tries again next time")
    }
    current = null
    pending--
    if (pending <= 0) closeModel()
  }

  // ── the beat model ─────────────────────────────────────────────────────────

  private var session: OrtSession? = null

  private fun <T> withModel(block: ((FloatArray, Int) -> Pair<FloatArray, FloatArray>) -> T): T {
    val env = OrtEnvironment.getEnvironment()
    val s = session ?: env.createSession(
      context.assets.open(MODEL).use { it.readBytes() },
      OrtSession.SessionOptions().apply { setIntraOpNumThreads(MODEL_THREADS) },
    ).also { session = it }
    return block { x, frames ->
      val buf = ByteBuffer.allocateDirect(x.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
      buf.put(x).rewind()
      OnnxTensor.createTensor(env, buf, longArrayOf(1, frames.toLong(), Lite.N_MELS.toLong())).use { input ->
        s.run(mapOf("spect" to input)).use { out ->
          @Suppress("UNCHECKED_CAST")
          val beat = (out.get(0).value as Array<FloatArray>)[0]
          @Suppress("UNCHECKED_CAST")
          val down = (out.get(1).value as Array<FloatArray>)[0]
          beat to down
        }
      }
    }
  }

  private fun closeModel() {
    session?.close()
    session = null
  }

  companion object {
    private const val MEDIA_URI = "content://media/"
    private const val MODEL = "beat_small.onnx"
    private const val MODEL_THREADS = 2
    private const val MAX_ATTEMPTS = 2
    private const val SETTLE_MS = 5000L
    private const val MIN_MS = 45_000L // ringtones and clips
    private const val MAX_MS = 15 * 60_000L // triage's "long": compilations and hour-long loops
  }
}
