package com.saics.player.engine

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.LockSupport
import kotlin.math.roundToInt
import kotlin.random.Random

/**
 * The SAICS playback engine (P6). Three threads:
 * - **audio**: [Renderer] -> AudioTrack (float, 44.1 kHz), real-time, parks while paused;
 * - **scheduler** (this class's loop): loads songs into slots, runs the Forever walk one bar
 *   ahead, turns button intents into [Instruction]s;
 * - **decoder**: [Decoder] fills slots (one song at a time).
 * Public methods may be called from any thread; they enqueue work for the scheduler.
 */
class Engine(private val context: Context, private val listener: Listener) {
  interface Listener {
    /** The song now playing changed (main thread). */
    fun onSong(song: Song?)
    /** Something the engine did: "jump", "version", "track", "repeat", "end" (main thread). */
    fun onAction(kind: String, detail: String)
  }

  class Song(
    val id: String,
    val uri: Uri,
    val bundleUri: Uri?,
    val title: String,
    val group: String,
    val version: String,
    val gainDb: Double,
    val trackId: String = "",
    @Volatile var notLoopable: Boolean = false,
  )

  private class Loaded(val song: Song, val pcm: Pcm, val bundle: Bundle?) {
    var barFrames: IntArray? = null // bar starts (frames); last entry = end of audio
    private var provisional = true
    var walk: ForeverWalk? = null
    var landBar = -1
    var came: Triple<String, Int, Int>? = null // the portal it arrived through
    var entered = false // the mix walk has this song
    /** Bar starts from the bundle. While the song is still decoding they are provisional (the
     *  last bar's end is unknown): good for finding bars, not for the walk or the song end. */
    fun bars(): IntArray? {
      val b = bundle ?: return null
      if (pcm.complete && provisional) {
        val t = b.barTimes(pcm.frames.toDouble() / ENGINE_RATE)
        barFrames = IntArray(t.size) { (t[it] * ENGINE_RATE).roundToInt().coerceIn(0, pcm.frames) }
        provisional = false
      } else if (barFrames == null && b.downbeats.size > 1) {
        barFrames = IntArray(b.downbeats.size) { (b.beats[b.downbeats[it]] * ENGINE_RATE).roundToInt() }
      }
      return barFrames
    }
    /** Index of the bar containing [frame]; -1 before the first downbeat. */
    fun barAt(frame: Int): Int {
      val b = bars() ?: return -1
      var lo = 0
      var hi = b.size - 1
      if (frame < b[0]) return -1
      while (hi - lo > 1) {
        val mid = (lo + hi) / 2
        if (b[mid] <= frame) lo = mid else hi = mid
      }
      return lo
    }
  }

  private enum class Kind { TRACK, NEXT, HARD_NEXT, PREVIOUS, RESTART, VERSION, MOVE }
  private class Intent(val kind: Kind, val target: Song?, var issuedAt: Int = -1, val move: Move? = null)

  private val slots = Array(SLOTS) { Slot() }
  private val loaded = arrayOfNulls<Loaded>(SLOTS)
  val renderer = Renderer(slots)
  private val main = Handler(Looper.getMainLooper())
  private val work = LinkedBlockingQueue<() -> Unit>()
  // One thread per song being decoded, so a requested version never waits behind a preload.
  private val decoder = Executors.newCachedThreadPool {
    Thread({ Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); it.run() }, "saics-decode")
  }
  @Volatile private var running = true

  // Scheduler-thread state.
  private var queue: List<Song> = emptyList()
  private var library: List<Song> = emptyList()
  private var index = 0
  private var forever = false
  private var vinylWanted = false
  private var intent: Intent? = null
  private var alt: Song? = null // preloaded other version (Forever)
  private var lastSlot = -1
  private var lastKey = Long.MIN_VALUE
  private var landBar = -1 // where a version switch lands (walk.reset)
  private var endRetry = -1 // slot whose song end couldn't be handed over yet (next song loading)
  private var jumpPending: String? = null // the scheduled Forever jump, announced once executed
  private var executedSeen = 0
  private val bad = HashSet<String>() // songs that won't open or decode on this phone

  // Mix Web (P4a).
  private var graph: PortalGraph? = null
  private var mix: MixWalk? = null
  private var mixOn = false // a station is walking the graph (plain queue otherwise)
  private var pool: Set<String>? = null
  private var byTrack: Map<String, Song> = emptyMap()
  private var moveInFlight: Move? = null // issued, the song hasn't changed yet
  private var moveRetry: Move? = null // due at the song end, target still loading
  private var plan: Move? = null // the next move on offer (Now Playing)
  private var jumps = 0

  /** For the UI: rebuilt once per bar on the scheduler thread. */
  @Volatile private var snapshot: Map<String, Any?> = emptyMap()
  private val rng = Random(System.nanoTime())

  @Volatile var current: Song? = null
    private set

  private val audioThread = Thread({ audioLoop() }, "saics-audio")
  private val schedThread = Thread({ schedLoop() }, "saics-sched")

  init {
    audioThread.start()
    schedThread.start()
  }

  // ── public API (any thread) ────────────────────────────────────────────────

  fun setLibrary(songs: List<Song>) = post {
    library = songs
    byTrack = songs.filter { it.trackId.isNotEmpty() }.associateBy { it.trackId }
  }

  /** `.saics/portals.json`; null or unreadable: no portals, plain playback and Forever only. */
  fun setPortals(uri: Uri?) = post {
    graph = uri?.let { readText(it) }?.let { PortalGraph.parse(it) }
    mix = graph?.let { g -> MixWalk(g).also { it.forever = forever; it.pool = pool } }
    loaded.forEach { it?.entered = false }
    log("portal graph: ${graph?.tracks?.size ?: 0} songs")
  }

  /** A station walks the graph; [songs] is its pool. Off: the queue plays in order. */
  fun setMix(on: Boolean, songs: Set<String>?) = post {
    mixOn = on
    pool = songs
    mix?.pool = songs
  }

  fun stay() = post {
    val p = plan
    mix?.stay(p)
    if (p != null && moveInFlight?.at == p.at && moveInFlight?.to == p.to) {
      renderer.pending.get()?.let { if (it.tag == TAG_MOVE) renderer.pending.compareAndSet(it, null) }
      moveInFlight = null
    }
    log("stay ${p?.to}")
    plan = null
    lastKey = Long.MIN_VALUE // refresh the card
  }

  fun switchVersionTo(song: Song) = post { intent = Intent(Kind.VERSION, song) }

  fun setNotLoopable(id: String, value: Boolean) = post {
    (loaded.firstOrNull { it?.song?.id == id })?.let {
      it.song.notLoopable = value
      it.walk = null
      it.entered = false
    }
    library.firstOrNull { it.id == id }?.notLoopable = value
  }

  /** "Portals from" a song: one row per target, most portals first. */
  fun portalsFrom(trackId: String): List<Map<String, Any?>> {
    val g = graph ?: return emptyList()
    val songs = byTrack
    return g.tracks[trackId]?.portals.orEmpty().filter { !it.sameGroup && it.to in g.tracks }.groupBy { g.tracks.getValue(it.to).key }.map { (_, es) ->
      val best = es.maxByOrNull { it.score }!! // one row per song, whichever versions it lands in
      val t = g.tracks.getValue(best.to)
      mapOf(
        "trackId" to best.to, "title" to (songs[best.to]?.title ?: best.to), "count" to es.size,
        "pair" to best.pair, "bpm" to t.bpm, "camelot" to t.camelot,
      )
    }.sortedByDescending { it["count"] as Int }.take(6)
  }

  /** Song facts and the next move, for the app. */
  fun status(): Map<String, Any?> {
    val l = loaded.getOrNull(renderer.slot) ?: return emptyMap()
    return snapshot + ("bar" to l.barAt(renderer.frame))
  }

  private val mixActive get() = mix != null && (mixOn || forever)

  fun setQueue(songs: List<Song>, start: Int) = post {
    queue = songs
    index = start.coerceIn(0, maxOf(0, songs.size - 1))
    songs.getOrNull(index)?.let { intent = Intent(Kind.TRACK, it) }
  }

  fun play() {
    renderer.playing = true
    LockSupport.unpark(audioThread)
  }

  fun pause() {
    renderer.playing = false
  }

  val isPlaying get() = renderer.playing

  fun next(hard: Boolean) = post {
    log("next(hard=$hard) forever=$forever current=${current?.title} versions=${current?.let { versionsOf(it).size }} alt=${alt?.version}")
    val w = mix
    val here = loaded.getOrNull(renderer.slot)
    if (hard && forever) { // a completely different song; Forever stays on
      val m = if (w != null && here != null && here.entered) w.newSong(here.barAt(renderer.frame)) else null
      val song = m?.let { byTrack[it.to] }
      if (m != null && song != null) {
        renderer.pending.get()?.let { if (it.tag == TAG_JUMP) renderer.pending.compareAndSet(it, null) }
        intent = Intent(Kind.MOVE, song, move = m)
        return@post
      }
      val c = current
      val other = library.filter { it.id !in bad && (c == null || (it.id != c.id && (c.group.isEmpty() || it.group != c.group))) }.randomOrNull(rng)
      if (other != null) {
        renderer.pending.get()?.let { if (it.tag == TAG_JUMP) renderer.pending.compareAndSet(it, null) }
        intent = Intent(Kind.HARD_NEXT, other)
      }
      return@post
    }
    if (w != null && mixActive && here != null && here.entered) {
      val move = w.nextNow(here.barAt(renderer.frame))
      val song = move?.let { byTrack[it.to] }
      if (move != null && song != null) {
        renderer.pending.get()?.let { if (it.tag == TAG_JUMP) renderer.pending.compareAndSet(it, null) }
        intent = Intent(Kind.MOVE, song, move = if (hard) move.copy(kind = "cut", at = -1) else move)
        return@post
      }
    }
    if (forever && current != null) { // x1 stays in the song: only x2 changes songs
      val versions = versionsOf(current!!).filter { it.id !in bad }
      if (versions.isEmpty()) event("error", "No other version")
      else intent = Intent(Kind.VERSION, alt ?: versions.random(rng))
    } else {
      queue.getOrNull(index + 1)?.let { intent = Intent(if (hard) Kind.HARD_NEXT else Kind.NEXT, it) }
        ?: queue.firstOrNull()?.let { index = -1; intent = Intent(Kind.NEXT, it) }
    }
  }

  fun previous() = post {
    val s = renderer.slot
    val sec = if (s >= 0) renderer.frame.toDouble() / ENGINE_RATE else 0.0
    intent = if (sec < 5.0 && index > 0) Intent(Kind.PREVIOUS, queue[index - 1]) else current?.let { Intent(Kind.RESTART, it) }
  }

  fun setForever(on: Boolean) = post {
    forever = on
    mix?.forever = on
    if (!on) renderer.pending.get()?.let { if (it.tag == TAG_JUMP) renderer.pending.compareAndSet(it, null) }
  }

  fun setVinyl(on: Boolean) = post { vinylWanted = on } // applied on the next bar

  fun setVinylComp(db: Double) {
    renderer.vinylComp = Math.pow(10.0, db / 20).toFloat()
  }

  fun duck(level: Float) {
    renderer.duck = level
  }

  fun positionMs(): Long = renderer.frame * 1000L / ENGINE_RATE
  fun durationMs(): Long = loaded.getOrNull(renderer.slot)?.pcm?.let { if (it.complete) it.frames * 1000L / ENGINE_RATE else null } ?: 0L

  fun release() {
    running = false
    renderer.playing = false
    LockSupport.unpark(audioThread)
    schedThread.interrupt()
    decoder.shutdownNow()
    loaded.forEach { it?.pcm?.cancelled = true }
  }

  /** Recent scheduler decisions, for `adb shell dumpsys activity service ...PlaybackService`
   *  (this phone filters app logcat output). Never written from the audio thread. */
  private val trace = ArrayDeque<String>()

  private fun log(msg: String) {
    Log.i(TAG, msg)
    synchronized(trace) {
      trace.addLast("%.1f %s".format(android.os.SystemClock.elapsedRealtime() / 1000.0, msg))
      while (trace.size > 200) trace.removeFirst()
    }
  }

  fun dump(): String {
    val head = "slot=${renderer.slot} frame=${renderer.frame} executed=${renderer.executed} playing=${renderer.playing} " +
      "forever=$forever vinyl=$vinylWanted/${renderer.vinylOn} intent=${intent?.kind}->${intent?.target?.title} " +
      "pending=${renderer.pending.get()?.let { "${it.from}@${it.at}->${it.toSlot}:${it.to}" }} alt=${alt?.version}\n" +
      loaded.mapIndexed { i, l ->
        "  slot $i: ${l?.song?.title} [${l?.song?.version}] frames=${l?.pcm?.frames} complete=${l?.pcm?.complete} " +
          "failed=${l?.pcm?.failed} bundle=${l?.bundle != null} walk=${l?.walk != null}"
      }.joinToString("\n")
    return head + "\n" + synchronized(trace) { trace.joinToString("\n") }
  }

  private fun post(f: () -> Unit) {
    work.offer(f)
  }

  // ── audio thread ───────────────────────────────────────────────────────────

  private fun audioLoop() {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val min = AudioTrack.getMinBufferSize(ENGINE_RATE, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_FLOAT)
    val track = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build(),
      )
      .setAudioFormat(
        AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setSampleRate(ENGINE_RATE)
          .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build(),
      )
      .setBufferSizeInBytes(maxOf(min * 2, (ENGINE_RATE * 0.12).toInt() * 8))
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
    val buf = FloatArray(BLOCK * 2)
    var started = false
    while (running) {
      if (!renderer.playing && renderer.fade == 0f) {
        if (started) {
          track.pause()
          started = false
        }
        LockSupport.parkNanos(50_000_000L)
        continue
      }
      if (!started) {
        track.play()
        started = true
      }
      renderer.render(buf, BLOCK)
      track.write(buf, 0, BLOCK * 2, AudioTrack.WRITE_BLOCKING)
    }
    track.stop()
    track.release()
  }

  // ── scheduler thread ───────────────────────────────────────────────────────

  private fun schedLoop() {
    while (running) {
      try {
        val f = work.poll(TICK_MS, TimeUnit.MILLISECONDS)
        f?.invoke()
        while (true) (work.poll() ?: break).invoke()
        tick()
      } catch (e: InterruptedException) {
        return
      } catch (e: Exception) {
        log("scheduler error: $e") // keep the scheduler alive; a bad bundle must never stop the music
      }
    }
  }

  private fun tick() {
    val cs = renderer.slot
    if (cs != lastSlot) songStarted(cs)
    if (renderer.executed != executedSeen) {
      executedSeen = renderer.executed
      jumpPending?.let { event("jump", it) }
      jumpPending = null
    } else if (jumpPending != null && renderer.pending.get() == null && renderer.armedSlot < 0) {
      jumpPending = null // dropped (Forever turned off, or a button replaced it)
    }
    resolveIntent()
    val cur = loaded.getOrNull(cs) ?: run { preload(); return }
    val bar = cur.barAt(renderer.frame)
    val key = (renderer.executed.toLong() shl 40) or ((cs.toLong() and 0xff) shl 32) or (bar.toLong() and 0xffffffffL)
    if (key != lastKey) {
      lastKey = key
      if (renderer.vinylOn != vinylWanted) renderer.vinylOn = vinylWanted // on the bar
      if (intent == null) decide(cs, cur, bar)
      refreshStatus(cur, bar)
    } else if (intent == null && renderer.pending.get() == null) {
      val retry = moveRetry
      if (retry != null) issueMove(cs, cur, retry)
      else if (cur.bars() == null) decide(cs, cur, bar) // no bundle: only the song end needs handling
      else if (endRetry == cs) songEnd(cs, cur)
    }
    preload()
  }

  /** What follows the bar now playing (one bar ahead), as forever_path would choose. */
  private fun decide(cs: Int, cur: Loaded, bar: Int) {
    if (renderer.pending.get() != null || !cur.pcm.complete) return
    val bars = cur.bars()
    if (bars == null) {
      val p = cur.pcm
      if (p.complete && renderer.frame > p.frames - 5 * ENGINE_RATE) songEnd(cs, cur)
      return
    }
    val n = bars.size - 1
    val boundary = bar + 1
    if (boundary > n) return
    val w = mix
    if (w != null && mixActive && cur.entered) {
      when (val d = w.step(boundary)) {
        MixWalk.Decision.Carry -> {}
        is MixWalk.Decision.Jump -> issueJump(cs, cur, bars, boundary, d.jump, d.why)
        is MixWalk.Decision.Leave -> issueMove(cs, cur, d.move)
      }
      return
    }
    val walk = cur.walk
    if (forever && walk != null) {
      when (val step = walk.step(boundary)) {
        is ForeverWalk.Step.Play -> {
          val j = step.jump ?: return
          issueJump(cs, cur, bars, boundary, j, step.why)
        }
        ForeverWalk.Step.End -> songEnd(cs, cur)
      }
    } else if (boundary == n) {
      songEnd(cs, cur)
    }
  }

  private fun issueJump(cs: Int, cur: Loaded, bars: IntArray, boundary: Int, j: Bundle.Jump, why: String) {
    val at = bars[minOf(boundary, bars.size - 1)]
    val to = bars[j.toBar]
    if (to + XF_HALF > cur.pcm.frames) return // target not decoded yet: carry on
    val rho = correlation(cur.pcm, at, cur.pcm, to, XF_HALF)
    renderer.pending.set(Instruction(cs, at, cs, to, XF_HALF, rho, tag = TAG_JUMP))
    log("jump ${j.label} ($why) at ${at / ENGINE_RATE.toDouble()}s rho=%.2f".format(rho))
    jumpPending = "${j.label} ($why)" // reported when it executes (see tick)
    jumps++
  }

  /** Hands a cross-song move to the renderer once the target is decoded far enough. */
  private fun issueMove(cs: Int, cur: Loaded, m: Move): Boolean {
    val bars = cur.bars() ?: return false
    if (m.kind == "end") { // a one-song pool, or Forever with no other version: repeat-one
      cur.pcm.frames.let { end ->
        renderer.pending.set(Instruction(cs, end, cs, 0, 0, gap = (ForeverWalk.REPEAT_ONE_GAP_S * ENGINE_RATE).toInt(), tag = TAG_REPEAT))
      }
      event("repeat", "repeat one")
      moveRetry = null
      return true
    }
    val atEnd = m.at >= bars.size - 1
    val song = byTrack[m.to]
    if (song == null) {
      moveRetry = null
      return false
    }
    if (song.id in bad || slotOf(song)?.let { loaded[it]?.pcm?.failed } == true) {
      unplayable(song)
      moveRetry = if (atEnd) mix?.fallback?.let { m.copy(to = it, toBar = 0) } else null // pick again
      return false
    }
    val s = slotOf(song) ?: load(song)
    val other = s?.let { loaded[it] }
    val ab = other?.bars()
    val to = if (m.toBar <= 0 || ab == null) 0 else ab[minOf(m.toBar, ab.size - 2)]
    if (s == null || other == null || !ready(s) || to + XF_HALF > other.pcm.frames) {
      moveRetry = if (atEnd) m else null // mid-song: the moment passes, carry on
      if (!atEnd) log("move to ${song.title} skipped: not decoded yet")
      return false
    }
    val at = if (atEnd) cur.pcm.frames else bars[m.at]
    val half = if (atEnd) 0 else XF_HALF
    val rho = if (m.kind == "portal" || m.kind == "back") correlation(cur.pcm, at, other.pcm, to, XF_HALF) else 0.0
    renderer.pending.set(Instruction(cs, at, s, to, half, rho, tag = TAG_MOVE))
    moveInFlight = m
    moveRetry = null
    log("${m.kind} ${m.pair} -> ${song.title} bar ${m.toBar} at bar ${m.at} score=%.2f rho=%.2f".format(m.score, rho))
    return true
  }

  private fun refreshStatus(cur: Loaded, bar: Int) {
    val w = mix
    val g = graph
    val info = g?.tracks?.get(cur.song.trackId)
    val b = cur.bundle
    plan = if (w != null && mixActive && cur.entered) moveInFlight ?: w.peek(bar) else null
    val p = plan
    p?.let { m -> byTrack[m.to]?.let { song -> if (slotOf(song) == null && intent == null) load(song) } }
    val kinds = info?.sections
    val sections = b?.sections.orEmpty()
    val sectionIndex = sections.indexOfFirst { bar >= it.startBar && bar < it.endBar }
    snapshot = mapOf(
      "trackId" to cur.song.trackId, "bpm" to (b?.bpm ?: 0.0), "camelot" to (b?.camelot ?: ""),
      "sections" to sections.mapIndexed { i, x -> mapOf("bars" to (x.endBar - x.startBar), "kind" to (kinds?.getOrNull(i) ?: "section")) },
      "sectionKind" to (kinds?.getOrNull(sectionIndex) ?: ""), "jumps" to jumps,
      "nextPortal" to p?.let { m ->
        val t = g?.tracks?.get(m.to)
        val song = byTrack[m.to]
        if (t == null || song == null) {
          null
        } else {
          mapOf(
            "kind" to if (m.kind == "portal") "portal" else if (m.kind == "back") "back" else "cut",
            "title" to song.title, "inBars" to maxOf(1, m.at - bar), "pair" to m.pair,
            "bpm" to t.bpm, "camelot" to t.camelot, "landBar" to m.toBar,
          )
        }
      },
    )
  }

  /** The song reached its end: (c) another version / (d) repeat-one in Forever, else the next song. */
  private fun songEnd(cs: Int, cur: Loaded) {
    endRetry = cs
    if (!cur.pcm.complete) return
    val end = cur.pcm.frames
    if (forever) {
      val a = alt
      val s = a?.let { slotOf(it) }
      if (a != null && s != null && ready(s)) {
        renderer.pending.set(Instruction(cs, end, s, 0, 0, tag = TAG_VERSION))
        endRetry = -1
        event("version", a.version + " (song end)")
      } else {
        cur.walk?.repeatOne()
        renderer.pending.set(Instruction(cs, end, cs, 0, 0, gap = (ForeverWalk.REPEAT_ONE_GAP_S * ENGINE_RATE).toInt(), tag = TAG_REPEAT))
        endRetry = -1
        event("repeat", "repeat one")
      }
    } else {
      val nextSong = nextInQueue() ?: return
      val s = slotOf(nextSong) ?: return
      if (!ready(s)) return
      renderer.pending.set(Instruction(cs, end, s, 0, 0, tag = TAG_TRACK))
      endRetry = -1
    }
  }

  /** Turns a button intent into an instruction once its target song is loaded enough. */
  private fun resolveIntent() {
    val it = intent ?: return
    val cs = renderer.slot
    val target = it.target ?: run { intent = null; return }
    val s = slotOf(target) ?: load(target) ?: return
    if (it.issuedAt >= 0) {
      if (renderer.executed > it.issuedAt && renderer.slot == s) {
        intent = null // done
        if (it.kind == Kind.RESTART || it.kind == Kind.PREVIOUS || it.kind == Kind.TRACK) loaded[s]?.walk?.reset(0)
      } else if (renderer.pending.get() == null && renderer.armedSlot != s) {
        it.issuedAt = -1 // something else ran first: issue again
      }
      return
    }
    if (loaded[s]?.pcm?.failed == true) {
      unplayable(target)
      return
    }
    if (!ready(s)) return
    val cur = loaded.getOrNull(cs)
    val now = renderer.frame
    val ins = when (it.kind) {
      Kind.TRACK -> Instruction(cs, -1, s, 0, if (cs >= 0) SWITCH_HALF else 0, tag = TAG_TRACK)
      Kind.HARD_NEXT, Kind.PREVIOUS, Kind.RESTART ->
        Instruction(cs, now + 2048, s, 0, SWITCH_HALF, tag = TAG_TRACK)
      Kind.NEXT -> Instruction(cs, nextBarFrame(cur, now), s, 0, SWITCH_HALF, tag = TAG_TRACK)
      Kind.MOVE -> {
        val m = it.move!!
        val other = loaded[s]!!
        val ab = other.bars()
        val to = if (m.toBar <= 0 || ab == null) 0 else ab[minOf(m.toBar, ab.size - 2)]
        if (to + XF_HALF > other.pcm.frames) return // not decoded that far yet (retried each tick)
        val bars = cur?.bars()
        var at = if (m.at < 0 || bars == null) now + 2048 else bars[minOf(m.at, bars.size - 1)]
        if (at - XF_HALF <= now + BLOCK * 2) at = nextBarFrame(cur, now) // decoding took too long
        moveInFlight = m.copy(at = if (cur != null) maxOf(0, cur.barAt(at)) else 0)
        val rho = if (m.kind == "portal" && cur != null) correlation(cur.pcm, at, other.pcm, to, XF_HALF) else 0.0
        Instruction(cs, at, s, to, XF_HALF, rho, tag = TAG_MOVE)
      }
      Kind.VERSION -> {
        val other = loaded[s]!!
        val cb = cur?.bars()
        val ab = other.bars()
        val at = nextBarFrame(cur, now)
        val land = if (cb != null && ab != null) {
          val b = (cur.barAt(at) * (ab.size - 1).toDouble() / (cb.size - 1)).roundToInt().coerceIn(0, ab.size - 2)
          landBar = b
          ab[b]
        } else {
          landBar = -1
          (now.toLong() * other.pcm.capacity / maxOf(1, cur?.pcm?.capacity ?: 1)).toInt()
        }
        if (land + SWITCH_HALF > other.pcm.frames) return // not decoded that far yet (retried each tick)
        Instruction(cs, at, s, land, SWITCH_HALF, tag = TAG_VERSION)
      }
    }
    // Nothing is playing: the position won't advance to any "at", so start right away.
    renderer.pending.set(if (cs < 0) Instruction(-1, -1, s, ins.to, 0, tag = ins.tag) else ins)
    log("${it.kind} -> ${target.title} [${target.version}] at ${ins.at} to ${ins.to} (now $now)")
    it.issuedAt = renderer.executed
    when (it.kind) {
      Kind.VERSION -> event("version", target.version)
      Kind.TRACK, Kind.MOVE -> {}
      else -> event("track", target.title)
    }
  }

  /** A song that won't open or decode: never again this session, and whoever wanted it moves on. */
  private fun unplayable(song: Song) {
    if (bad.add(song.id)) {
      log("can't play ${song.title}: skipping it")
      event("error", "Skipping a song that won't play")
    }
    mix?.markBad(song.trackId)
    if (alt?.id == song.id) alt = null
    if (plan?.to == song.trackId) plan = null
    val i = slotOf(song)
    if (i != null && i != renderer.slot && i != renderer.armedSlot) {
      loaded[i]?.pcm?.cancelled = true
      loaded[i] = null
      slots[i].pcm = null
    }
    val it = intent
    if (it?.target?.id == song.id) {
      intent = null
      if (it.kind == Kind.TRACK || it.kind == Kind.NEXT || it.kind == Kind.HARD_NEXT) {
        val at = queue.indexOfFirst { q -> q.id == song.id }
        val next = (1..queue.size).map { k -> queue[(maxOf(at, 0) + k) % queue.size] }.firstOrNull { q -> q.id !in bad }
        if (next != null) intent = Intent(it.kind, next)
      }
    }
  }

  /** The next song in the queue that can play. */
  private fun nextInQueue(): Song? =
    (1..queue.size).map { queue[(index + it) % queue.size] }.firstOrNull { it.id !in bad }

  private fun nextBarFrame(cur: Loaded?, now: Int): Int {
    val b = cur?.bars() ?: return now + 2048
    val i = cur.barAt(now)
    val nb = if (i + 1 < b.size) b[i + 1] else now + 2048
    return if (nb - now < ENGINE_RATE / 4) (if (i + 2 < b.size) b[i + 2] else nb) else nb
  }

  private fun songStarted(cs: Int) {
    lastSlot = cs
    val l = loaded.getOrNull(cs)
    val prev = current
    current = l?.song
    jumps = 0
    moveRetry = null
    if (l != null) {
      val mv = moveInFlight
      moveInFlight = null
      mix?.let { if (prev != null) it.left() }
      l.entered = false
      l.came = null
      if (mv != null && mv.to == l.song.trackId) {
        landBar = mv.toBar
        if (mv.kind == "portal" && prev != null) l.came = Triple(prev.trackId, mv.at, mv.toBar)
        event("portal", l.song.title)
      }
      index = queue.indexOfFirst { it.id == l.song.id }.let { if (it >= 0) it else index }
      log("playing ${l.song.title} [${l.song.version}] bundle=${l.bundle != null} decoded=${l.pcm.complete}")
      l.landBar = landBar // a version switch landed mid-song: the walk starts there
      landBar = -1
      initWalk(l)
      alt = null
    }
    main.post { listener.onSong(l?.song) }
  }

  /** The Forever walk needs the final bar grid, i.e. the whole song decoded. */
  private fun initWalk(l: Loaded) {
    if (l.bundle == null || !l.pcm.complete || l.bars() == null) return
    val times = l.bundle.barTimes(l.pcm.frames.toDouble() / ENGINE_RATE)
    val loopable = l.bundle.loopable && !l.song.notLoopable
    if (l.walk == null) {
      l.walk = ForeverWalk(times, l.bundle.sections, l.bundle.jumps, l.bundle.outroBar, loopable, rng.nextLong())
      if (l.landBar >= 0) l.walk?.reset(l.landBar)
    }
    val info = graph?.tracks?.get(l.song.trackId)
    val w = mix
    if (w != null && info != null && !l.entered) {
      w.enter(info, times, l.bundle.sections, l.bundle.jumps, l.bundle.outroBar, loopable, maxOf(0, l.landBar), l.came)
      l.entered = true
    }
  }

  // ── slots and preloading ───────────────────────────────────────────────────

  private fun versionsOf(s: Song): List<Song> =
    if (s.group.isEmpty()) emptyList() else library.filter { it.group == s.group && it.id != s.id }

  private fun preload() {
    val c = current
    if (forever && c != null) {
      if (alt == null) alt = versionsOf(c).filter { it.id !in bad }.randomOrNull(rng)
      alt?.let { slotOf(it) ?: load(it) }
    }
    // Near the end of a song on the walk: the fallback target must be ready.
    val here = loaded.getOrNull(renderer.slot)
    if (mixActive && here != null && here.pcm.complete && here.pcm.frames - renderer.frame < 40 * ENGINE_RATE) {
      mix?.fallback?.let { byTrack[it] }?.let { slotOf(it) ?: load(it) }
    }
    // The next song is only needed when this one can end into it.
    if (!mixOn && (!forever || c == null || versionsOf(c).isEmpty())) nextInQueue()?.let { slotOf(it) ?: load(it) }
    // Bars become available once decoding completes; the walk needs them.
    val l = loaded.getOrNull(renderer.slot)
    if (l != null) initWalk(l)
  }

  private fun slotOf(s: Song): Int? = loaded.indexOfFirst { it?.song?.id == s.id }.takeIf { it >= 0 }

  private fun ready(s: Int): Boolean {
    val p = loaded[s]?.pcm ?: return false
    return !p.failed && (p.complete || p.frames > 3 * ENGINE_RATE)
  }

  /** Decode [song] into a free slot (never one in use or about to be). */
  private fun load(song: Song): Int? {
    if (song.id in bad) return null
    val busy = setOf(renderer.slot, renderer.armedSlot, renderer.pending.get()?.toSlot ?: -1)
    val keep = setOfNotNull(
      alt?.id, nextInQueue()?.id.takeIf { !mixOn }, intent?.target?.id,
      plan?.let { byTrack[it.to]?.id }, moveInFlight?.let { byTrack[it.to]?.id }, moveRetry?.let { byTrack[it.to]?.id },
    )
    val free = (0 until SLOTS).firstOrNull { loaded[it] == null }
      ?: (0 until SLOTS).firstOrNull { it !in busy && loaded[it]?.song?.id !in keep }
      ?: return null
    loaded[free]?.pcm?.cancelled = true
    log("load ${song.title} [${song.version}] into slot $free")
    val opened = Decoder.open(context, song.uri) ?: run {
      unplayable(song)
      return null
    }
    val (pcm, job) = opened
    val bundle = song.bundleUri?.let { readText(it) }?.let { Bundle.parse(it) }
    loaded[free] = Loaded(song, pcm, bundle)
    slots[free].pcm = pcm
    slots[free].gain = Math.pow(10.0, song.gainDb.coerceIn(-30.0, MAX_BOOST_DB) / 20).toFloat()
    decoder.execute(job)
    return free
  }

  private fun readText(uri: Uri): String? = try {
    context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
  } catch (e: Exception) {
    null
  }

  private fun event(kind: String, detail: String) = main.post { listener.onAction(kind, detail) }

  companion object {
    private const val TAG = "SaicsEngine"
    const val SLOTS = 4
    const val BLOCK = 512
    const val TICK_MS = 10L
    const val XF_HALF = 662 // 15 ms: render.py uses a 30 ms seam crossfade
    const val SWITCH_HALF = 1102 // 25 ms: version / track cut on the downbeat
    const val MAX_BOOST_DB = 10.0
    const val TAG_JUMP = 1
    const val TAG_VERSION = 2
    const val TAG_TRACK = 3
    const val TAG_REPEAT = 4
    const val TAG_MOVE = 5

    /** Normalised correlation of two windows around the seam (render.py's rho). */
    fun correlation(a: Pcm, at: Int, b: Pcm, to: Int, half: Int): Double {
      var ab = 0.0
      var aa = 0.0
      var bb = 0.0
      for (k in -half until half) {
        val i = at + k
        val j = to + k
        if (i < 0 || j < 0 || i >= a.frames || j >= b.frames) continue
        val x = (a.left(i) + a.right(i)).toDouble()
        val y = (b.left(j) + b.right(j)).toDouble()
        ab += x * y; aa += x * x; bb += y * y
      }
      return (ab / (Math.sqrt(aa * bb) + 1e-12)).coerceIn(0.0, 1.0)
    }
  }
}
