import { useEffect, useState, type CSSProperties } from "react";

/**
 * The song change (a portal or a skip), as on the phone (app/src/app/now-playing.tsx): one hand
 * takes the old record up and away, the other brings the new one in from below and lets go, while
 * the obi strip slides out and back with the new title. 3.2 s; the keyframes are the phone's, in
 * its units (the record is 520 wide), scaled to the record on this screen.
 */
export const PORTAL_MS = 3200;
export const SHRINK = 380 / 520; // the records are held a little smaller than they sit
const TWOS = 1000 / 12; // hand-drawn motion moves on twos

export interface Crossing {
  from: string;
  to: string;
  pair: string;
  start: number;
}

/** Piecewise-linear, like Animated.interpolate. */
export function lerp(p: number, xs: number[], ys: number[]): number {
  if (p <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (p <= xs[i]) {
      const span = xs[i] - xs[i - 1] || 1;
      return ys[i - 1] + ((p - xs[i - 1]) / span) * (ys[i] - ys[i - 1]);
    }
  }
  return ys[ys.length - 1];
}

/** Progress 0..1 through the crossing, stepped on twos, and the hand drawing to show. */
export function useCrossing(c: Crossing | null, onDone: () => void): { p: number; frame: number } {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!c) return;
    const id = window.setInterval(() => {
      const t = performance.now();
      setNow(t);
      const slow = import.meta.env.DEV ? ((window as unknown as { saicsSlow?: number }).saicsSlow ?? 1) : 1;
      if (t - c.start >= PORTAL_MS * slow) onDone();
    }, TWOS);
    return () => clearInterval(id);
  }, [c, onDone]);
  if (!c) return { p: 0, frame: 0 };
  // Development only: window.saicsSlow = 10 plays the crossing ten times slower, to look at it.
  const slow = import.meta.env.DEV ? ((window as unknown as { saicsSlow?: number }).saicsSlow ?? 1) : 1;
  const ms = Math.max(0, now - c.start) / slow;
  return { p: Math.min(1, ms / PORTAL_MS), frame: Math.floor(ms / 125) % 3 };
}

/** The record being carried away (u: pixels per phone unit). */
export function outgoingStyle(p: number, u: number): CSSProperties {
  const x = lerp(p, [0, 0.14, 0.3, 0.62, 0.82, 1], [0, 0, 40, 40, 420, 420]) * u;
  const y = lerp(p, [0, 0.14, 0.3, 0.62, 0.82, 1], [0, 0, -134, -134, -760, -760]) * u;
  const s = lerp(p, [0, 0.14, 0.3, 1], [1, 1, SHRINK, SHRINK]);
  return { transform: `translate(${x}px, ${y}px) scale(${s})` };
}

/** The record being brought in. */
export function incomingStyle(p: number, u: number): CSSProperties {
  const x = lerp(p, [0, 0.16, 0.32, 0.62, 0.84, 1], [550, 550, 210, 210, 0, 0]) * u;
  const y = lerp(p, [0, 0.16, 0.32, 0.62, 0.84, 1], [476, 476, 86, 86, 0, 0]) * u;
  const s = lerp(p, [0, 0.62, 0.84, 1], [SHRINK, SHRINK, 1, 1]);
  return { transform: `translate(${x}px, ${y}px) scale(${s})` };
}

/** A grip hand, inside its record's box so the record carries it. (112, 130) of the 430 x 900
 *  drawing is where the fingers meet the rim. */
export function Grip({ which, p, u, frame }: { which: "out" | "in"; p: number; u: number; frame: number }) {
  const w = (430 * u) / SHRINK;
  const h = (900 * u) / SHRINK;
  const ox = (112 * u) / SHRINK;
  const oy = (130 * u) / SHRINK;
  const style: CSSProperties =
    which === "out"
      ? {
          left: 500 * u - ox, top: 150 * u - oy,
          transform: `translate(${lerp(p, [0, 0.03, 0.16, 1], [340, 340, 0, 0]) * u}px, ${lerp(p, [0, 0.03, 0.16, 1], [-560, -560, 0, 0]) * u}px) rotate(-100deg)`,
        }
      : {
          left: 219 * u - ox, top: 513 * u - oy,
          // lets go once it has landed
          transform: `translate(${lerp(p, [0, 0.62, 0.76, 1], [0, 0, 420, 420]) * u}px, ${lerp(p, [0, 0.62, 0.76, 1], [0, 0, 700, 700]) * u}px) rotate(-10deg)`,
        };
  return (
    <div className="grip" style={{ ...style, width: w, height: h, transformOrigin: `${ox}px ${oy}px` }} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <img key={i} src={`hand/grip${i}.webp`} alt="" style={{ opacity: frame === i ? 1 : 0 }} />
      ))}
    </div>
  );
}

/** The text below fades away while the records cross, then comes back. */
export const bodyOpacity = (p: number) => lerp(p, [0, 0.14, 0.26, 0.8, 0.92, 1], [1, 1, 0, 0, 1, 1]);
/** "Same beat. New song." shows in the middle. */
export const copyOpacity = (p: number) => lerp(p, [0, 0.28, 0.34, 0.62, 0.68, 1], [0, 0, 1, 1, 0, 0]);
/** The two records' overlap flickers vermilion as they pass. */
export const lensOpacity = (p: number) => lerp(p, [0, 0.3, 0.36, 0.44, 0.48, 0.52, 0.6, 0.66, 1], [0, 0, 1, 1, 0.75, 1, 1, 0, 0]);
/** The obi strip slides out and back, changing title while it's away (at 2 s). */
export const obiShift = (p: number, u: number) => lerp(p, [0, 0.12, 0.24, 0.72, 0.86, 1], [0, 0, 100, 100, 0, 0]) * u;
export const landed = (p: number) => p * PORTAL_MS >= 2000;
