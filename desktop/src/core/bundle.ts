/** The parts of a `saics.analysis/9` bundle the player uses (engine/saics/schema.py; Bundle.kt). */

export interface Section {
  startBar: number;
  endBar: number;
  group: number;
}

export interface Jump {
  fromBar: number;
  toBar: number;
  score: number;
  kind: string;
  label: string;
}

export interface Bundle {
  beats: number[];
  downbeats: number[];
  sections: Section[];
  jumps: Jump[];
  outroBar: number | null;
  loopable: boolean;
  gainDb: number;
  bpm: number;
  camelot: string;
}

export const BUNDLE_SCHEMA = "saics.analysis/9";

/** Null when unreadable or another schema: the song then plays straight through. */
export function parseBundle(text: string): Bundle | null {
  try {
    const o = JSON.parse(text);
    if (o.schema !== BUNDLE_SCHEMA) return null;
    const outro = o.outro_bar == null ? null : Number(o.outro_bar) > 0 ? Number(o.outro_bar) : null;
    return {
      beats: o.beats.map(Number),
      downbeats: o.downbeats.map(Number),
      sections: o.sections.map((s: Record<string, number>) => ({ startBar: s.start_bar, endBar: s.end_bar, group: s.group })),
      jumps: (o.jumps ?? []).map((j: Record<string, never>) => ({
        fromBar: j.from_bar, toBar: j.to_bar, score: j.score, kind: j.kind, label: j.label,
      })),
      outroBar: outro,
      loopable: o.loopable ?? true,
      gainDb: o.loudness?.gain_db ?? 0,
      bpm: o.tempo?.bpm ?? 0,
      camelot: o.key?.camelot ?? "",
    };
  } catch {
    return null;
  }
}

/** Bar start times (s); the last bar runs to the end of the audio, as render.py `_bar_times`. */
export function barTimes(b: Bundle, audioSeconds: number): number[] {
  const n = b.downbeats.length - 1;
  if (n < 1) return [0, audioSeconds];
  const t = Array.from({ length: n + 1 }, (_, i) => b.beats[b.downbeats[i]]);
  t[n] = Math.max(audioSeconds, t[n - 1] + 0.01);
  return t;
}

/** Index of the bar playing at `s` seconds (-1 before the first downbeat). */
export function barAt(t: number[], s: number): number {
  let lo = 0;
  let hi = t.length - 1;
  if (s < t[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, t.length - 2);
}
