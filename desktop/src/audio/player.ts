import { barAt, barTimes, type Bundle } from "../core/bundle";
import { ForeverWalk, REPEAT_ONE_GAP_S } from "../core/foreverWalk";
import { MixWalk, Seams, type Move } from "../core/mixWalk";
import { Rng } from "../core/rng";
import type { Library, Track } from "./library";

/**
 * The desktop player: the phone engine (Engine.kt) on Web Audio. Each song is decoded whole, and
 * every seam is two buffer sources crossfaded on the downbeat. As on the phone, the bar that
 * follows the one playing is decided one bar ahead, by the Forever walk or the Infinite Ride walk.
 */

const SEAM_S = 0.03; // render.py's 30 ms seam crossfade, centred on the downbeat
const SWITCH_S = 0.05; // a song picked by hand, a version, a cut
const MAX_BOOST_DB = 10;
const KEEP_DECODED = 4; // whole songs in memory (about 90 MB each as float audio)
export const STATIONS = ["Infinite Ride", "Late Night", "Liked"] as const;

interface Loaded {
  track: Track;
  buffer: AudioBuffer;
  bundle: Bundle | null;
  barT: number[] | null;
  walk: ForeverWalk | null;
  gain: number;
}

interface Seg {
  loaded: Loaded;
  src: AudioBufferSourceNode;
  gain: GainNode;
  at: number; // context time it's fully in
  offset: number; // song seconds at `at`
  why: "start" | "jump" | "move" | "repeat" | "skip";
  move?: Move;
  label?: string;
  came?: [string, number, number];
  cameOffset?: number;
}

export type PlayerEvent =
  | { type: "jump-soon"; label: string }
  | { type: "jump"; label: string }
  | { type: "portal"; kind: string; title: string; pair: string }
  | { type: "error"; message: string };

export interface PlayerState {
  track: Track | null;
  playing: boolean;
  loading: boolean;
  forever: boolean;
  station: string | null;
  jumps: number;
  jumpPoints: number | null; // null: not analysed
  bpm: number;
  camelot: string;
  next: { kind: string; title: string; inBars: number } | null;
}

const dbToGain = (db: number) => 10 ** (Math.max(-30, Math.min(MAX_BOOST_DB, db)) / 20);

export class Player {
  readonly ctx = new AudioContext({ latencyHint: "playback" });
  private master = this.ctx.createGain();
  private lib: Library | null = null;
  private byId = new Map<string, Track>();
  private mix: MixWalk | null = null;
  private mixOn = false;
  private entered = false;
  private stationIndex = -1;
  private queue: Track[] = [];
  private index = 0;
  private live: Seg | null = null;
  private pending: Seg | null = null;
  private retry: Move | null = null;
  private lastBar = -2;
  private plan: Move | null = null;
  private decoded = new Map<string, Promise<Loaded>>();
  private order: string[] = [];
  private rng = new Rng();
  private bad = new Map<string, number>(); // file -> until (ms)
  private jumps = 0;
  private loading = false;
  private timer = 0;
  forever = localStorage.getItem("saics.forever") !== "false";
  liked = new Set<string>(JSON.parse(localStorage.getItem("saics.liked") ?? "[]"));
  private listeners = new Set<(e: PlayerEvent | null) => void>();

  private wantPlaying = false; // what the owner asked for; the browser may suspend audio on its own

  constructor() {
    this.master.connect(this.ctx.destination);
    this.timer = window.setInterval(() => this.tick(), 50);
    this.ctx.onstatechange = () => {
      // Suspended by the browser, not by Pause (a hidden pane, a device change): carry on.
      if (this.ctx.state === "suspended" && this.wantPlaying) void this.ctx.resume().catch(() => {});
      this.emit();
    };
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  on(f: (e: PlayerEvent | null) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private emit(e: PlayerEvent | null = null): void {
    this.listeners.forEach((f) => f(e));
  }

  setLibrary(lib: Library): void {
    this.lib = lib;
    this.byId = new Map(lib.tracks.filter((t) => t.id).map((t) => [t.id, t]));
    this.mix = lib.graph ? new MixWalk(lib.graph, new Rng()) : null;
    if (this.mix) {
      this.mix.forever = this.forever;
      this.mix.blocked = (id) => this.isBad(this.byId.get(id)?.file);
    }
    this.emit();
  }

  get playing(): boolean {
    return this.wantPlaying && !!this.live;
  }

  private get mixActive(): boolean {
    return !!this.mix && (this.mixOn || this.forever);
  }

  state(): PlayerState {
    const L = this.live?.loaded;
    const p = this.plan;
    const bar = L?.barT ? barAt(L.barT, this.position()) : -1;
    return {
      track: L?.track ?? null,
      playing: this.playing,
      loading: this.loading,
      forever: this.forever,
      station: this.stationIndex >= 0 ? STATIONS[this.stationIndex] : null,
      jumps: this.jumps,
      jumpPoints: L ? (L.bundle ? L.bundle.jumps.length : null) : null,
      bpm: L?.bundle?.bpm ?? 0,
      camelot: L?.bundle?.camelot ?? "",
      next: p && this.mixOn ? { kind: p.kind, title: this.byId.get(p.to)?.title ?? "", inBars: Math.max(0, p.at - bar) } : null,
    };
  }

  /** Seconds into the song now playing. */
  position(): number {
    const s = this.live;
    return s ? s.offset + Math.max(0, this.ctx.currentTime - s.at) : 0;
  }

  duration(): number {
    return this.live?.loaded.buffer.duration ?? 0;
  }

  // ── decoding ───────────────────────────────────────────────────────────────

  private isBad(file?: string): boolean {
    return !!file && (this.bad.get(file) ?? 0) > Date.now();
  }

  private load(t: Track): Promise<Loaded> {
    const have = this.decoded.get(t.file);
    if (have) {
      this.order = [t.file, ...this.order.filter((f) => f !== t.file)];
      return have;
    }
    const lib = this.lib!;
    const p = (async () => {
      const [bytes, bundle] = await Promise.all([lib.source.bytes(t.file), lib.bundle(t)]);
      const buffer = await this.ctx.decodeAudioData(bytes);
      const barT = bundle && bundle.downbeats.length > 1 ? barTimes(bundle, buffer.duration) : null;
      const walk = bundle && barT ? new ForeverWalk(barT, bundle.sections, bundle.jumps, bundle.outroBar, bundle.loopable && !t.notLoopable, this.rng.nextSeed()) : null;
      return { track: t, buffer, bundle, barT, walk, gain: dbToGain(bundle?.gainDb ?? 0) };
    })();
    p.catch(() => {
      this.decoded.delete(t.file);
      this.bad.set(t.file, Date.now() + 2 * 60_000); // a passing failure: try again later
      this.mix?.markBad(t.id);
      this.emit({ type: "error", message: `Couldn't play ${t.title}` });
    });
    this.decoded.set(t.file, p);
    this.order = [t.file, ...this.order.filter((f) => f !== t.file)];
    // Keep the few songs that matter; let the rest go.
    const keep = new Set([this.live?.loaded.track.file, this.pending?.loaded.track.file, t.file].filter(Boolean));
    for (const f of [...this.order].reverse()) {
      if (this.decoded.size <= KEEP_DECODED) break;
      if (!keep.has(f)) {
        this.decoded.delete(f);
        this.order = this.order.filter((x) => x !== f);
      }
    }
    return p;
  }

  // ── seams ──────────────────────────────────────────────────────────────────

  private source(L: Loaded, when: number, offset: number, fade: number): { src: AudioBufferSourceNode; gain: GainNode } {
    const src = this.ctx.createBufferSource();
    src.buffer = L.buffer;
    const gain = this.ctx.createGain();
    src.connect(gain).connect(this.master);
    const start = Math.max(this.ctx.currentTime, when - fade / 2);
    gain.gain.setValueAtTime(fade ? 0 : L.gain, start);
    if (fade) gain.gain.linearRampToValueAtTime(L.gain, when + fade / 2);
    src.start(start, Math.max(0, offset - (when - start)));
    return { src, gain };
  }

  /** The current song gives way at `when` to `offset` of `L`, over `fade` seconds. */
  private seam(L: Loaded, when: number, offset: number, fade: number, info: Partial<Seg> & { why: Seg["why"] }): void {
    const old = this.live;
    if (this.pending) this.cancelPending();
    if (old) {
      const g = old.gain.gain;
      g.cancelScheduledValues(when - fade / 2);
      g.setValueAtTime(old.loaded.gain, Math.max(this.ctx.currentTime, when - fade / 2));
      g.linearRampToValueAtTime(0, when + fade / 2);
      old.src.stop(when + fade / 2 + 0.05);
    }
    const { src, gain } = this.source(L, when, offset, fade);
    const seg: Seg = { loaded: L, src, gain, at: when, offset, ...info };
    if (!old) {
      this.live = seg;
      this.songStarted(null, seg);
    } else {
      this.pending = seg;
    }
  }

  private cancelPending(): void {
    const p = this.pending;
    if (!p) return;
    try {
      p.src.stop();
    } catch {
      /* not started */
    }
    p.src.disconnect();
    this.pending = null;
    if (this.live) {
      const g = this.live.gain.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setValueAtTime(this.live.loaded.gain, this.ctx.currentTime);
      try {
        this.live.src.stop(this.ctx.currentTime + 3600 * 24);
      } catch {
        /* already stopping */
      }
    }
  }

  /** When the song playing reaches `songSeconds`, in context time. */
  private when(songSeconds: number): number {
    const s = this.live!;
    return s.at + (songSeconds - s.offset);
  }

  // ── the clock ──────────────────────────────────────────────────────────────

  private tick(): void {
    if (!this.live || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    if (this.pending && now >= this.pending.at) {
      const prev = this.live;
      this.live = this.pending;
      this.pending = null;
      this.songStarted(prev, this.live);
    }
    const L = this.live.loaded;
    if (this.retry && !this.pending) {
      const m = this.retry;
      this.retry = null;
      void this.issueMove(m);
    }
    if (!L.barT) {
      // No analysis: play it through, then the next song.
      if (!this.pending && this.position() > L.buffer.duration - 1.5) this.songEnd();
      return;
    }
    const bar = barAt(L.barT, this.position());
    if (bar !== this.lastBar) {
      this.lastBar = bar;
      if (!this.pending) this.decide(bar + 1);
      this.emit();
    }
  }

  private decide(boundary: number): void {
    const L = this.live!.loaded;
    const n = L.barT!.length - 1;
    if (this.mixActive && this.entered && this.mix) {
      const d = this.mix.step(boundary);
      this.plan = this.mixOn ? this.mix.peek(boundary) : null;
      if (this.plan) {
        const t = this.byId.get(this.plan.to);
        if (t) void this.load(t).catch(() => {});
      }
      if (d.kind === "jump") this.scheduleJump(boundary, d.jump.toBar, d.jump.label);
      else if (d.kind === "leave") void this.issueMove(d.move);
      return;
    }
    if (this.forever && L.walk) {
      const s = L.walk.step(boundary);
      if (s.kind === "end") this.repeatOne();
      else if (s.jump) this.scheduleJump(boundary, s.jump.toBar, s.jump.label);
      return;
    }
    if (boundary >= n) this.songEnd();
    else this.preloadNext();
  }

  private scheduleJump(fromBar: number, toBar: number, label: string): void {
    const L = this.live!.loaded;
    const t = L.barT!;
    const when = this.when(t[fromBar]);
    if (when < this.ctx.currentTime + 0.02) return; // too late for this bar
    this.seam(L, when, t[toBar], SEAM_S, { why: "jump", label });
    this.emit({ type: "jump-soon", label });
  }

  private repeatOne(): void {
    const L = this.live!.loaded;
    this.mix?.repeatOne();
    L.walk?.repeatOne();
    const when = this.when(L.buffer.duration) + REPEAT_ONE_GAP_S;
    this.seam(L, when, 0, 0, { why: "repeat" });
  }

  private preloadNext(): void {
    const next = this.queue[(this.index + 1) % Math.max(1, this.queue.length)];
    if (next && !this.mixOn) void this.load(next).catch(() => {});
  }

  /** The end of a song with no walk deciding: the next one in the queue, gapless. */
  private songEnd(): void {
    const L = this.live!.loaded;
    if (this.forever) {
      this.repeatOne();
      return;
    }
    const next = this.nextInQueue();
    if (!next) return;
    void this.load(next).then((N) => {
      if (this.live?.loaded !== L || this.pending) return;
      this.index = this.queue.indexOf(next);
      this.seam(N, Math.max(this.ctx.currentTime + 0.05, this.when(L.buffer.duration)), 0, 0, { why: "start" });
    });
  }

  private nextInQueue(): Track | null {
    for (let k = 1; k <= this.queue.length; k++) {
      const t = this.queue[(this.index + k) % this.queue.length];
      if (!this.isBad(t.file)) return t;
    }
    return null;
  }

  /** A cross-song move from the walk (or Next): at its bar, with the portal's timing. */
  private async issueMove(m: Move, now = false): Promise<void> {
    const L = this.live?.loaded;
    if (!L || !L.barT) return;
    if (m.kind === "end") {
      this.repeatOne();
      return;
    }
    const target = this.byId.get(m.to);
    if (!target) return;
    const n = L.barT.length - 1;
    const atEnd = m.at >= n;
    let N: Loaded;
    try {
      N = await this.load(target);
    } catch {
      return;
    }
    if (this.live?.loaded !== L || this.pending) return;
    const early = Seams.earlyMs(m.kind, m.toBar) / 1000;
    const land = N.barT && m.toBar > 0 ? N.barT[Math.min(m.toBar, N.barT.length - 2)] + m.offsetMs / 1000 + early : 0;
    let when: number;
    if (now || m.at < 0) {
      when = this.ctx.currentTime + 0.08;
    } else {
      when = this.when(atEnd ? L.buffer.duration : L.barT[m.at] + early);
      if (when < this.ctx.currentTime + 0.02) {
        if (atEnd) when = this.ctx.currentTime + 0.05;
        else if (this.lastBar + 1 < n) {
          when = this.when(L.barT[this.lastBar + 1]); // decoding took too long: the next downbeat
          if (when < this.ctx.currentTime + 0.02) return;
        } else return;
      }
    }
    const came: [string, number, number] | undefined = m.kind === "portal" ? [L.track.id, m.at, m.toBar] : undefined;
    this.seam(N, when, Math.max(0, land), atEnd ? 0 : m.kind === "portal" || m.kind === "back" ? SEAM_S : SWITCH_S, {
      why: "move", move: m, came, cameOffset: m.offsetMs,
    });
  }

  private songStarted(prev: Seg | null, seg: Seg): void {
    const L = seg.loaded;
    const songChanged = !prev || prev.loaded !== L;
    if (seg.why === "jump") {
      this.jumps++;
      this.emit({ type: "jump", label: seg.label ?? "" });
    }
    if (songChanged) {
      this.jumps = 0;
      if (prev && this.entered) this.mix?.left();
      this.entered = false;
      L.walk?.newVisit();
      const i = this.queue.indexOf(L.track);
      if (i >= 0) this.index = i;
      if (prev && (seg.why === "move" || seg.why === "skip")) {
        this.emit({ type: "portal", kind: seg.move?.kind ?? "cut", title: L.track.title, pair: seg.move?.kind === "portal" ? seg.move.pair : "" });
      }
      const g = this.lib?.graph?.get(L.track.id);
      if (this.mix && g && L.bundle && L.barT && this.mixActive) {
        const landBar = seg.move ? seg.move.toBar : L.barT ? Math.max(0, barAt(L.barT, seg.offset)) : 0;
        this.mix.enter(g, L.barT, L.bundle.sections, L.bundle.jumps, L.bundle.outroBar, L.bundle.loopable && !L.track.notLoopable,
          landBar, seg.came ?? null, seg.cameOffset ?? 0);
        this.entered = true;
      }
      this.lastBar = -2;
      this.updateMedia();
    }
    this.emit();
  }

  // ── what the owner does ────────────────────────────────────────────────────

  private async startNow(t: Track, why: Seg["why"] = "start"): Promise<void> {
    this.loading = true;
    this.emit();
    try {
      const N = await this.load(t);
      this.wantPlaying = true;
      if (this.ctx.state !== "running") await this.ctx.resume();
      this.seam(N, this.ctx.currentTime + 0.06, 0, this.live ? SWITCH_S : 0, { why });
    } catch {
      /* reported by load */
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  /** A song picked by hand: the library plays on in order after it. */
  playTrack(t: Track): void {
    if (!this.lib) return;
    this.bad.delete(t.file); // chosen by hand: try it again, whatever happened before
    this.queue = this.lib.tracks;
    this.index = this.queue.indexOf(t);
    this.mixOn = false;
    this.stationIndex = -1;
    if (this.mix) this.mix.pool = null;
    void this.startNow(t);
  }

  /** A station: one version per song, shuffled, walked as an Infinite Ride. */
  startStation(i: number): void {
    if (!this.lib) return;
    const all = this.lib.tracks;
    let pool = i === 1 ? all.filter((t) => t.version.includes("slowed")) : i === 2 ? all.filter((t) => this.liked.has(t.file)) : all;
    if (!pool.length) pool = all;
    const analysed = pool.filter((t) => t.id);
    if (analysed.length) pool = analysed;
    const groups = new Map<string, Track[]>();
    for (const t of pool) groups.set(t.group || t.file, [...(groups.get(t.group || t.file) ?? []), t]);
    const queue = [...groups.values()]
      .map((vs) => (Math.random() < 0.5 && i !== 1 ? vs.find((v) => v.version === "original") : undefined) ?? vs[Math.floor(Math.random() * vs.length)])
      .sort(() => Math.random() - 0.5);
    if (!queue.length) return;
    this.queue = queue;
    this.index = 0;
    this.stationIndex = i;
    this.mixOn = true;
    if (this.mix) this.mix.pool = new Set(pool.map((t) => t.id).filter(Boolean));
    void this.startNow(queue[0]);
  }

  async togglePlay(): Promise<void> {
    if (!this.live) {
      if (this.lib?.tracks.length) this.startStation(0);
      return;
    }
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    if (this.wantPlaying) {
      this.wantPlaying = false;
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.1);
      await new Promise((r) => setTimeout(r, 120));
      await this.ctx.suspend();
    } else {
      this.wantPlaying = true;
      await this.ctx.resume();
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setValueAtTime(0, this.ctx.currentTime);
      g.linearRampToValueAtTime(1, this.ctx.currentTime + 0.1);
    }
    this.updateMedia();
    this.emit();
  }

  /** Next x1: a portal within two bars, else a different song now. Next x2: a different song now. */
  next(hard: boolean): void {
    const L = this.live?.loaded;
    if (!L || !this.lib) return;
    const bar = L.barT ? barAt(L.barT, this.position()) : -1;
    if (this.pending && this.pending.why === "jump") this.cancelPending();
    if (!(hard && this.forever) && this.mixActive && this.entered && this.mix) {
      const m = this.mix.nextNow(bar);
      if (m) {
        void this.issueMove(hard ? { ...m, kind: "cut", at: -1 } : m);
        return;
      }
    }
    if (this.forever || this.mixActive) {
      const m = this.mix && this.entered ? this.mix.newSong(bar) : null;
      if (m) {
        void this.issueMove(m);
        return;
      }
      const others = this.lib.tracks.filter((t) => t.file !== L.track.file && (!L.track.group || t.group !== L.track.group) && !this.isBad(t.file));
      const pick = others[Math.floor(Math.random() * others.length)];
      if (pick) void this.startNow(pick, "skip");
      return;
    }
    const nxt = this.nextInQueue();
    if (nxt) void this.startNow(nxt, "skip");
  }

  /** Previous: the song before when it has only just started, else from the top. */
  previous(): void {
    const L = this.live?.loaded;
    if (!L) return;
    if (this.position() < 5 && this.index > 0 && !this.mixOn) {
      void this.startNow(this.queue[this.index - 1], "skip");
      return;
    }
    this.cancelPending();
    L.walk?.reset(0);
    this.seam(L, this.ctx.currentTime + 0.06, 0, SWITCH_S, { why: "start" });
    this.lastBar = -2;
  }

  toggleForever(): void {
    this.forever = !this.forever;
    if (this.mix) this.mix.forever = this.forever;
    if (!this.forever && this.pending?.why === "jump") this.cancelPending();
    localStorage.setItem("saics.forever", String(this.forever));
    // Re-enter the walk so the change counts from the next bar.
    if (this.live) {
      const L = this.live.loaded;
      const g = this.lib?.graph?.get(L.track.id);
      this.entered = false;
      if (this.mix && g && L.bundle && L.barT && this.mixActive) {
        this.mix.enter(g, L.barT, L.bundle.sections, L.bundle.jumps, L.bundle.outroBar, L.bundle.loopable && !L.track.notLoopable,
          Math.max(0, barAt(L.barT, this.position())), null);
        this.entered = true;
      }
    }
    this.emit();
  }

  toggleLike(t: Track | null): void {
    if (!t) return;
    if (this.liked.has(t.file)) this.liked.delete(t.file);
    else this.liked.add(t.file);
    localStorage.setItem("saics.liked", JSON.stringify([...this.liked]));
    this.emit();
  }

  // ── the OS's media controls (keyboard keys, headset buttons) ─────────────────

  private silence: HTMLAudioElement | null = null;

  /** Chrome only shows media controls for a playing media element: a silent one keeps them up. */
  private updateMedia(): void {
    if (!("mediaSession" in navigator)) return;
    const t = this.live?.loaded.track;
    if (!this.silence) {
      this.silence = new Audio(silentWav());
      this.silence.loop = true;
    }
    if (this.playing) void this.silence.play().catch(() => {});
    else this.silence.pause();
    navigator.mediaSession.playbackState = this.playing ? "playing" : "paused";
    if (t) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.groupName && t.version !== "original" ? `${t.title}` : t.title,
        artist: this.forever ? "SAICS · Forever" : "SAICS",
        artwork: [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }],
      });
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    void this.ctx.close();
  }
}

/** Two seconds of silence as a WAV data URL. */
function silentWav(): string {
  const rate = 8000;
  const n = rate * 2;
  const b = new DataView(new ArrayBuffer(44 + n));
  const w = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  b.setUint32(4, 36 + n, true);
  w(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, rate, true);
  b.setUint32(28, rate, true);
  b.setUint16(32, 1, true);
  b.setUint16(34, 8, true);
  w(36, "data");
  b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  let s = "";
  new Uint8Array(b.buffer).forEach((x) => (s += String.fromCharCode(x)));
  return `data:audio/wav;base64,${btoa(s)}`;
}
