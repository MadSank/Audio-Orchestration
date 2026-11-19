/**
 * The record is the timeline (as on the PC: desktop/src/ui/Turntable.tsx). The song is pressed as one
 * spiral groove, rim to label, a turn for every 8 bars, and the record turns under a tonearm that only
 * moves in. Turning the record by hand moves through the song; a jump swings it back (or on); a portal
 * flings the stylus round the label and away.
 *
 * Geometry is in the record's own units (Record's 520 viewBox, centre 260); on screen one unit is k.
 */
export const BARS_PER_TURN = 8;
const C = 260;
const R_OUT = 246; // the song's first bar
const R_IN = 104; // its last, just outside the label
/** The tonearm's pivot, just left of the obi strip, and its length: the stylus stays on the part of
 *  the record the screen shows, clear of the strip and the text below. */
export const PIVOT = { x: 476, y: 124 };
export const ARM = 270;
const NO_BARS_S = 2; // a song with no analysis turns as if its bars were 2 s long

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function barAt(t: number[], s: number): number {
  if (s < t[0]) return -1;
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Fractional bar at `s` seconds. */
export function barFrac(bars: number[] | null, s: number): number {
  if (!bars || bars.length < 2) return s / NO_BARS_S;
  const n = bars.length - 1;
  const i = clamp(barAt(bars, s), 0, n - 1);
  return i + (s - bars[i]) / Math.max(0.01, bars[i + 1] - bars[i]);
}

/** Seconds at fractional bar `b`. */
export function secondsAt(bars: number[] | null, b: number): number {
  if (!bars || bars.length < 2) return b * NO_BARS_S;
  const n = bars.length - 1;
  const i = clamp(Math.floor(b), 0, n - 1);
  return bars[i] + (b - i) * (bars[i + 1] - bars[i]);
}

export const totalBars = (bars: number[] | null, duration: number) => (bars && bars.length > 1 ? bars.length - 1 : duration / NO_BARS_S);
export const radiusAt = (b: number, total: number) => R_OUT - (R_OUT - R_IN) * clamp(b / Math.max(1, total), 0, 1);
/** How far the record has turned at bar `b`, in degrees, clockwise. */
export const turnDeg = (b: number) => (b / BARS_PER_TURN) * 360;

/** Where the stylus sits (angle from the centre, radians) when it's `r` from the centre. */
function stylusAngle(r: number): number {
  const dx = PIVOT.x - C;
  const dy = PIVOT.y - C;
  const d = Math.hypot(dx, dy);
  return Math.atan2(dy, dx) + Math.acos(clamp((r * r + d * d - ARM * ARM) / (2 * r * d), -1, 1));
}

/** The tonearm's angle (degrees, from the pivot) with the stylus `r` from the centre. */
export function armDeg(r: number): number {
  const a = stylusAngle(r);
  return (Math.atan2(C + r * Math.sin(a) - PIVOT.y, C + r * Math.cos(a) - PIVOT.x) * 180) / Math.PI;
}

/** A point of the groove at bar `b`, on the record before it turns. */
function groove(b: number, total: number): [number, number] {
  const r = radiusAt(b, total);
  const a = stylusAngle(r) - (turnDeg(b) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

export function groovePath(from: number, to: number, total: number): string {
  const a = clamp(from, 0, total);
  const b = clamp(to, 0, total);
  if (b - a < 0.01) return "";
  const n = Math.max(2, Math.ceil(((b - a) / BARS_PER_TURN) * 30));
  let d = "";
  for (let i = 0; i <= n; i++) {
    const [x, y] = groove(a + ((b - a) * i) / n, total);
    d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

/** A short mark across the groove at bar `b` (where a portal leaves). */
export function grooveTick(b: number, total: number): string {
  const r = radiusAt(b, total);
  const a = stylusAngle(r) - (turnDeg(b) * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return `M${C + (r - 8) * c} ${C + (r - 8) * s}L${C + (r + 8) * c} ${C + (r + 8) * s}`;
}

/** The fling: once round the label, opening out, then away to the lower right. u: 0..1. */
export function slingshot(r0: number, u: number): [number, number] {
  const a = stylusAngle(r0) + 6.2 * u;
  const r = r0 + (1000 - r0) * u ** 2.4;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}
