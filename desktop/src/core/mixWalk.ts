import type { Jump, Section } from "./bundle";
import { ForeverWalk } from "./foreverWalk";
import { Rng } from "./rng";

/** `.saics/portals.json` (engine/saics/schema.py PortalGraph; MixWalk.kt PortalGraph). */
export interface Edge {
  fromBar: number;
  to: string;
  toBar: number;
  score: number;
  pair: string;
  sameGroup: boolean;
  offsetMs: number;
}

export interface GraphTrack {
  id: string;
  file: string;
  group: string;
  bpm: number;
  camelot: string;
  sections: string[];
  bars: number;
  entries: number[];
  breakExits: Set<number>;
  portals: Edge[];
  walkable: boolean;
  exits: number; // portals out to other song groups
  key: string; // group, or the id for a song on its own
}

export type PortalGraph = Map<string, GraphTrack>;
export const GRAPH_SCHEMA = "saics.portals/2";

export function makeTrack(t: Omit<GraphTrack, "exits" | "key">): GraphTrack {
  return { ...t, exits: t.portals.filter((e) => !e.sameGroup).length, key: t.group || t.id };
}

/** Null when unreadable or another schema: the player then works without portals. */
export function parseGraph(text: string): PortalGraph | null {
  try {
    const o = JSON.parse(text);
    if (o.schema !== GRAPH_SCHEMA) return null;
    const out: PortalGraph = new Map();
    for (const [id, t] of Object.entries<Record<string, never>>(o.tracks)) {
      out.set(
        id,
        makeTrack({
          id,
          file: t.file ?? "",
          group: t.group ?? "",
          bpm: t.bpm ?? 0,
          camelot: t.camelot ?? "",
          sections: t.sections ?? [],
          bars: t.bars ?? 0,
          entries: (t.entries as number[])?.length ? t.entries : [0],
          breakExits: new Set<number>(t.break_exits ?? []),
          portals: ((t.portals ?? []) as Record<string, never>[]).map((e) => ({
            fromBar: e.from_bar, to: e.to, toBar: e.to_bar, score: e.score, pair: e.pair,
            sameGroup: e.same_group, offsetMs: e.offset_ms ?? 0,
          })),
          walkable: t.walkable ?? true,
        }),
      );
    }
    return out;
  } catch {
    return null;
  }
}

/** Leave this song: at bar `at`, continue at `toBar` of track `to`. */
export interface Move {
  kind: string; // portal | back | cut | break | version | end
  to: string;
  toBar: number;
  at: number;
  pair: string;
  score: number;
  offsetMs: number; // landing shift (portal and back moves)
}

const move = (kind: string, to: string, toBar: number, at: number, pair = "", score = 0, offsetMs = 0): Move => ({
  kind, to, toBar, at, pair, score, offsetMs,
});

/** engine/saics/seams.py: the portal seam's timing (round 3c: 29 ms early, trim off). */
export const Seams = {
  EARLY_MS: -29,
  earlyMs(kind: string, toBar: number): number {
    return (kind === "portal" || kind === "back") && toBar > 0 ? -29 : 0;
  },
};

export type Decision = { kind: "carry" } | { kind: "jump"; jump: Jump; why: string } | { kind: "leave"; move: Move };

export const DWELL_MIN = 60;
export const DWELL_MAX = 90;
export const MIN_DWELL_S = 30;
const NO_REPEAT_COUNT = 8;
const NO_REPEAT_S = 20 * 60;
export const PORTAL_SCORE_MIN = 0.6;
const EXITS_BONUS = 0.05;
const CUT_POOL = 12;
const BREAK_AFTER_S = 30;
const VERSION_AFTER_S = 60;
const CUT_AFTER_S = 90;
const BACK_REACH_BARS = 4;
export const NEXT_REACH_BARS = 2; // owner, 2026-11-18: a press must change song within two bars
const STAY_HOLD_S = 45;

/**
 * Port of MixWalk.kt (itself engine/saics/mixwalk.py): the Infinite Ride walk over the portal
 * graph. One visit at a time: `enter` when a song is ready, `step` once a bar, one bar ahead.
 */
export class MixWalk {
  forever = false;
  pool: Set<string> | null = null;
  blocked: (id: string) => boolean = () => false;
  t = 0;
  cur: GraphTrack | null = null;
  jumpsTaken = 0;
  fallback: string | null = null;

  private bad = new Set<string>();
  private history: [string, number][] = [];
  private barT: number[] = [0];
  private sections: Section[] = [];
  private kinds: string[] = [];
  private walk: ForeverWalk | null = null;
  private cameFrom: [string, number, number] | null = null;
  private cameOffsetMs = 0;
  private visitT = 0;
  private dwell = 60;
  private chorusDone = false;
  private chorusFrom = -1;
  private deadSince: number | null = null;
  private holdUntil = 0;
  private stays = new Set<string>();

  constructor(private graph: PortalGraph, private rng: Rng = new Rng()) {}

  private get n(): number {
    return this.barT.length - 1;
  }

  enter(
    track: GraphTrack, times: number[], secs: Section[], jumps: Jump[], outro: number | null, loopable: boolean,
    bar: number, came: [string, number, number] | null, cameOffset = 0,
  ): void {
    this.cur = track;
    this.barT = times;
    this.sections = secs;
    this.kinds = track.sections;
    this.cameFrom = came;
    this.cameOffsetMs = cameOffset;
    this.visitT = 0;
    this.dwell = DWELL_MIN + (DWELL_MAX - DWELL_MIN) * this.rng.nextDouble();
    this.chorusDone = false;
    this.chorusFrom = -1;
    this.deadSince = null;
    this.holdUntil = 0;
    this.stays.clear();
    this.walk = new ForeverWalk(times, secs, jumps, outro, loopable, this.rng.nextSeed());
    if (bar > 0) this.walk.reset(bar);
    this.jumpsTaken = 0;
    this.fallback = this.pickTarget();
  }

  /** Record leaving the current song (at the moment the next one starts). */
  left(): void {
    if (this.cur) this.history.push([this.cur.key, this.t]);
  }

  markBad(id: string): void {
    this.bad.add(id);
    if (this.fallback === id) this.fallback = this.pickTarget();
  }

  private allowed(id: string): boolean {
    const g = this.graph.get(id);
    if (!g || this.bad.has(id) || this.blocked(id) || !g.walkable) return false;
    if (this.pool && !this.pool.has(id)) return false;
    if (g.key === this.cur?.key) return false;
    return !this.history.slice(-NO_REPEAT_COUNT).some(([k, at]) => k === g.key && this.t - at < NO_REPEAT_S);
  }

  private dwelled(extra = 0): boolean {
    const vt = this.visitT + extra;
    return vt >= this.dwell || (this.chorusDone && vt >= MIN_DWELL_S);
  }

  private edgeOk(e: Edge): boolean {
    if (this.stays.has(`${e.fromBar}|${e.to}|${e.toBar}`) || e.score < PORTAL_SCORE_MIN) return false;
    if (this.forever) return e.sameGroup && this.graph.has(e.to) && !this.bad.has(e.to); // Forever stays in the song
    return !e.sameGroup && this.allowed(e.to);
  }

  private rank(e: Edge): number {
    return e.score + ((this.graph.get(e.to)?.exits ?? 0) > 0 ? EXITS_BONUS : 0);
  }

  private best(edges: Edge[], jitter = false): Edge | null {
    let best: Edge | null = null;
    let bestV = -Infinity;
    for (const e of edges) {
      const v = this.rank(e) + (jitter ? this.rng.nextDouble() * 0.02 : 0);
      if (v > bestV) {
        bestV = v;
        best = e;
      }
    }
    return best;
  }

  private portalsFrom(bar: number): Edge[] {
    return (this.cur?.portals ?? []).filter((e) => e.fromBar === bar && this.edgeOk(e));
  }

  /** The next portal the walk would take after `bar` (shown on Now Playing, and preloaded). */
  peek(bar: number): Move | null {
    for (let b = Math.max(0, bar + 1); b < this.n; b++) {
      if (!this.dwelled(this.barT[b] - this.barT[Math.max(0, bar)])) continue;
      const e = this.best(this.portalsFrom(b));
      if (e) return move("portal", e.to, e.toBar, b, e.pair, e.score, e.offsetMs);
    }
    return null;
  }

  /** Skip this portal and keep the song. */
  stay(m: Move | null): void {
    if (m) this.stays.add(`${m.at}|${m.to}|${m.toBar}`);
    this.holdUntil = this.t + STAY_HOLD_S;
    this.deadSince = null;
  }

  /** What to play instead of / as `bar` (decided one bar ahead). */
  step(bar: number): Decision {
    if (this.dwelled()) {
      const e = this.best(this.portalsFrom(bar), true);
      if (e) return { kind: "leave", move: move("portal", e.to, e.toBar, bar, e.pair, e.score, e.offsetMs) };
    }
    if (this.forever) return this.foreverBar(bar);
    const ahead = (this.cur?.portals ?? []).some((e) => this.edgeOk(e) && e.fromBar > bar);
    if (this.dwelled() && !ahead && this.t >= this.holdUntil) {
      if (this.deadSince == null) this.deadSince = this.t;
    } else if (ahead) {
      this.deadSince = null;
    }
    if (this.deadSince != null) {
      const m = this.fallbackMove(bar, this.t - this.deadSince);
      if (m) return { kind: "leave", move: m };
      return this.foreverBar(bar);
    }
    if (bar >= this.n) return { kind: "leave", move: this.songEnd(bar) };
    this.trackChorus(bar);
    if (bar >= 0) {
      this.walk?.plain(bar);
      this.advance(bar);
    }
    return { kind: "carry" };
  }

  private foreverBar(bar: number): Decision {
    const r = this.walk?.step(bar);
    if (!r) return { kind: "carry" };
    if (r.kind === "end") return { kind: "leave", move: this.songEnd(bar) };
    if (!r.jump) {
      this.trackChorus(bar);
      this.advance(bar);
      return { kind: "carry" };
    }
    this.jumpsTaken++;
    this.advance(r.jump.toBar);
    return { kind: "jump", jump: r.jump, why: r.why };
  }

  /** Back in this song after leaving it: every jump is new again. */
  newVisit(): void {
    this.walk?.newVisit();
  }

  /** The song repeats from the top (repeat-one). */
  repeatOne(): void {
    this.walk?.repeatOne();
  }

  private advance(bar: number): void {
    if (bar < 0 || bar >= this.n) return;
    const dt = this.barT[bar + 1] - this.barT[bar];
    this.t += dt;
    this.visitT += dt;
  }

  private sectionAt(bar: number): number {
    return this.sections.findIndex((s) => bar >= s.startBar && bar < s.endBar);
  }

  private trackChorus(bar: number): void {
    const i = this.sectionAt(bar);
    if (i < 0 || (this.kinds[i] ?? "section") !== "chorus") {
      this.chorusFrom = -1;
      return;
    }
    const s = this.sections[i];
    if (bar === s.startBar) this.chorusFrom = s.startBar;
    if (bar === s.endBar - 1 && this.chorusFrom === s.startBar) this.chorusDone = true;
  }

  private isPhrase(bar: number): boolean {
    if (bar === 0) return true;
    const i = this.sectionAt(bar);
    return i >= 0 && (bar - this.sections[i].startBar) % 4 === 0;
  }

  nextPhrase(bar: number): number {
    for (let b = bar + 1; b < this.n; b++) if (this.isPhrase(b)) return b;
    return this.n;
  }

  /** Fallback destination: back toward the connected part of the graph, at close tempos. */
  private pickTarget(): string | null {
    const here = this.cur;
    if (!here) return null;
    const ids = [...this.graph.keys()].filter((id) => this.allowed(id)).sort();
    if (!ids.length) {
      const others = [...this.graph.keys()]
        .filter((id) => {
          const g = this.graph.get(id)!;
          return id !== here.id && g.walkable && g.key !== here.key && (!this.pool || this.pool.has(id));
        })
        .sort();
      const last = new Map(this.history);
      let pick: string | null = null;
      let when = Infinity;
      for (const id of others) {
        const w = last.get(this.graph.get(id)!.key) ?? -1;
        if (w < when) {
          when = w;
          pick = id;
        }
      }
      return pick;
    }
    const withExits = ids.filter((id) => (this.graph.get(id)?.exits ?? 0) > 0);
    const near = (withExits.length ? withExits : ids)
      .map((id) => [id, Math.abs((this.graph.get(id)?.bpm ?? 0) - here.bpm)] as const)
      .sort((a, b) => a[1] - b[1])
      .slice(0, CUT_POOL)
      .map(([id]) => id);
    return near[this.rng.nextInt(near.length)];
  }

  private cut(kind: string, bar: number): Move | null {
    const f = this.fallback;
    const id = f && this.graph.has(f) && !this.bad.has(f) && !this.blocked(f) ? f : this.pickTarget();
    if (!id) return null;
    return move(kind, id, this.graph.get(id)!.entries[0], bar, "cut");
  }

  private versions(): string[] {
    const g = this.cur?.group ?? "";
    if (!g) return [];
    return [...this.graph.values()]
      .filter((t) => t.group === g && t.id !== this.cur?.id && !this.bad.has(t.id) && !this.blocked(t.id) && t.walkable)
      .map((t) => t.id);
  }

  private fallbackMove(bar: number, looped: number): Move | null {
    const c = this.cur;
    if (!c) return null;
    const came = this.cameFrom;
    // The seam matched over the 4 bars after it, so any of them can go back, at that offset.
    if (came && bar - came[2] >= 0 && bar - came[2] < BACK_REACH_BARS && this.graph.has(came[0])) {
      return move("back", came[0], came[1] + bar - came[2], bar, "back", 0, -this.cameOffsetMs);
    }
    if (looped >= BREAK_AFTER_S && c.breakExits.has(bar)) return this.cut("break", bar);
    if (looped >= VERSION_AFTER_S && this.isPhrase(bar)) {
      const vs = this.versions();
      if (vs.length) {
        const v = vs[this.rng.nextInt(vs.length)];
        const other = this.graph.get(v)!;
        const land = Math.round(bar * (other.bars / Math.max(1, c.bars)));
        return move("version", v, Math.min(land, other.bars - 1), bar, "version");
      }
    }
    if (looped >= CUT_AFTER_S && this.isPhrase(bar)) return this.cut("cut", bar);
    return null;
  }

  private songEnd(bar: number): Move {
    const here = this.cur?.id ?? "";
    const vs = this.forever || this.deadSince != null ? this.versions() : [];
    if (vs.length) return move("version", vs[this.rng.nextInt(vs.length)], 0, bar, "version");
    if (this.forever) return move("end", here, 0, bar, "repeat"); // (d) repeat-one
    const c = this.cut("cut", bar);
    return c ? { ...c, toBar: 0 } : move("end", here, 0, bar, "repeat"); // a one-song pool
  }

  /** Next: a close portal at its own bar, else a cut on the next phrase (null: nowhere to go). */
  nextNow(bar: number): Move | null {
    for (let b = Math.max(0, bar + 1); b < Math.min(this.n, bar + 1 + NEXT_REACH_BARS); b++) {
      const e = this.best(this.portalsFrom(b));
      if (e) return move("portal", e.to, e.toBar, b, e.pair, e.score, e.offsetMs);
    }
    if (this.forever) return null; // the player changes song itself
    const at = this.nextPhrase(bar);
    const e = this.best((this.cur?.portals ?? []).filter((x) => this.edgeOk(x) && x.fromBar > bar));
    if (e) return move("cut", e.to, e.toBar, at, e.pair, e.score);
    return this.cut("cut", at);
  }

  /** Next x2 (and x1 with no portal close by): a completely different song, now. */
  newSong(bar: number): Move | null {
    const others = (this.cur?.portals ?? []).filter((e) => !e.sameGroup && e.score >= PORTAL_SCORE_MIN && this.allowed(e.to));
    const at = Math.max(0, bar + 1);
    const close = this.best(others.filter((e) => e.fromBar === at || e.fromBar === at + 1));
    if (close) return move("portal", close.to, close.toBar, close.fromBar, close.pair, close.score, close.offsetMs);
    const any = this.best(others);
    if (any) return move("cut", any.to, any.toBar, at, any.pair, any.score);
    return this.cut("cut", at);
  }
}
