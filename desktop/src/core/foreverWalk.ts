import type { Jump, Section } from "./bundle";
import { Rng } from "./rng";

/**
 * Port of ForeverWalk.kt (itself a port of engine/saics/jumps.py `forever_path`; keep all three in
 * step). Asked one bar ahead what follows the bar now playing.
 *
 * Endings follow the owner's priority: (a) the last backward repeat jump before the outro is taken
 * ("avoid the ending", at most AVOID_MAX_USES times a visit), (b) else a break loop, (c) else
 * another version of the song, (d) else repeat-one after a short gap. Each jump is taken at most
 * once a visit (owner, 2026-11-17).
 */
export type Step = { kind: "play"; bar: number; jump: Jump | null; why: string } | { kind: "end" };

export const TAKE_MIN = 0.6;
export const REPEAT_ONE_GAP_S = 1.5;
export const AVOID_MAX_USES = 1;

export class ForeverWalk {
  private rng: Rng;
  private n: number;
  private sec: number[];
  private byFrom = new Map<number, Jump[]>();
  readonly lastBack: number | null;
  private t = 0;
  private landed = -2;
  private nextAt: number;
  private recent: [number, number][] = [];
  private used = new Map<string, number>();

  constructor(
    private barT: number[],
    sections: Section[],
    jumps: Jump[],
    outroBar: number | null,
    loopable: boolean,
    seed: number,
    private pace: [number, number] = [60, 120],
  ) {
    this.rng = new Rng(seed);
    this.n = barT.length - 1;
    const outro = outroBar ?? this.n;
    this.sec = new Array(this.n).fill(-1);
    sections.forEach((s, k) => {
      for (let b = s.startBar; b < Math.min(s.endBar, this.n); b++) if (b >= 0) this.sec[b] = k;
    });
    for (const j of jumps) {
      if (j.kind !== "repeat" && j.kind !== "break") continue;
      const list = this.byFrom.get(j.fromBar) ?? [];
      list.push(j);
      this.byFrom.set(j.fromBar, list);
    }
    if (!loopable) {
      this.lastBack = null;
    } else {
      const back = jumps.filter((j) => (j.kind === "repeat" || j.kind === "break") && j.toBar < j.fromBar && j.fromBar <= outro);
      const rep = back.filter((j) => j.kind === "repeat").map((j) => j.fromBar);
      const brk = back.filter((j) => j.kind === "break").map((j) => j.fromBar);
      this.lastBack = rep.length ? Math.max(...rep) : brk.length ? Math.max(...brk) : null;
    }
    this.nextAt = this.uniform();
  }

  private uniform(): number {
    return this.pace[0] + (this.pace[1] - this.pace[0]) * this.rng.nextDouble();
  }

  /** Restart the walk at `bar` (song start, a version switch landing, or Previous). */
  reset(bar: number): void {
    this.landed = bar >= 1 && bar < this.n ? this.sec[bar] : -2;
    this.nextAt = this.t + this.uniform();
  }

  step(bar: number): Step {
    const here = this.byFrom.get(bar) ?? [];
    while (this.recent.length && this.t - this.recent[0][0] >= 60) this.recent.shift();
    const fresh = new Set(this.recent.map((r) => r[1]));
    if (this.lastBack != null && bar === this.lastBack) {
      const usable = here.filter((j) => j.toBar < bar && (this.used.get(j.label) ?? 0) < AVOID_MAX_USES);
      const notFresh = usable.filter((j) => !fresh.has(j.toBar));
      const options = notFresh.length ? notFresh : usable;
      if (options.length) {
        const key = (j: Jump): [number, number] => [j.kind === "repeat" ? 1 : 0, j.score + 0.002 * (bar - j.toBar)];
        const j = options.reduce((a, b) => {
          const ka = key(a);
          const kb = key(b);
          return kb[0] > ka[0] || (kb[0] === ka[0] && kb[1] > ka[1]) ? b : a;
        });
        return this.take(j, "avoid the ending");
      }
    }
    if (this.t >= this.nextAt && here.length && bar < this.n && this.sec[bar] !== this.landed) {
      const limit = this.lastBack ?? this.n;
      const options = here.filter(
        (j) => !fresh.has(j.toBar) && !this.used.has(j.label) && j.score >= TAKE_MIN && this.barT[limit] - this.barT[j.toBar] >= this.pace[0],
      );
      if (options.length) {
        let best = options[0];
        let bestV = -Infinity;
        for (const j of options) {
          const v = j.score + this.rng.nextDouble() * 0.02;
          if (v > bestV) {
            bestV = v;
            best = j;
          }
        }
        return this.take(best, "pacing");
      }
    }
    if (bar >= this.n) return { kind: "end" };
    this.played(bar);
    return { kind: "play", bar, jump: null, why: "" };
  }

  private take(j: Jump, why: string): Step {
    this.used.set(j.label, (this.used.get(j.label) ?? 0) + 1);
    this.landed = this.sec[j.toBar];
    this.nextAt = this.t + this.uniform();
    this.played(j.toBar);
    return { kind: "play", bar: j.toBar, jump: j, why };
  }

  /** Back in a song it played before (a portal, a skip): every jump is new again. */
  newVisit(): void {
    this.used.clear();
  }

  /** A bar played without a walk decision (keeps the clock and the recent list right). */
  plain(bar: number): void {
    if (bar >= 0 && bar < this.n) this.played(bar);
  }

  private played(bar: number): void {
    this.recent.push([this.t, bar]);
    this.t += this.barT[bar + 1] - this.barT[bar];
  }

  /** Repeat-one: the gap counts as played time, then the walk starts over at bar 0. */
  repeatOne(): void {
    this.t += REPEAT_ONE_GAP_S;
    this.used.clear();
    this.landed = -2;
    this.nextAt = this.t + this.uniform();
  }
}
