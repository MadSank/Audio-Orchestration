import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { barAt } from "../core/bundle";
import type { Player } from "../audio/player";

/**
 * The record is the timeline. The song is pressed as one spiral groove, rim to label, a turn for
 * every 8 bars (a phrase, so places that match tend to line up), and the record turns under an
 * arm that grows from the spindle to the groove and shortens as the song plays in. So turning the record by hand is moving through the
 * song, a jump is the record pushed back (or on), and a portal flings the stylus off the record,
 * round the label once like a probe round a planet, out towards the next song.
 *
 * Geometry is in the record's own units: 600 across, centre (300, 300).
 */
export const BARS_PER_TURN = 8;
const C = 300;
const R_OUT = 282; // the song's first bar
const R_IN = 128; // its last, just outside the label
/** The arm grows from the spindle out to the groove along this angle (radians, clockwise from
 *  3 o'clock): about 3 o'clock, below the finger (upper right) and above the title. It gets
 *  shorter as the song plays in towards the label. */
const ARM_ANGLE = (-4 * Math.PI) / 180;
const NO_BARS_S = 2; // a song with no analysis turns as if its bars were 2 s long
const EASE_MS = 380; // a jump: the record swings to its new place
const EJECT_MS = 1150;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Fractional bar at `s` seconds. */
export function barFrac(barT: number[] | null, s: number): number {
  if (!barT) return s / NO_BARS_S;
  const n = barT.length - 1;
  const i = clamp(barAt(barT, s), 0, n - 1);
  return i + (s - barT[i]) / Math.max(0.01, barT[i + 1] - barT[i]);
}

/** Seconds at fractional bar `b`. */
export function secondsAt(barT: number[] | null, b: number): number {
  if (!barT) return b * NO_BARS_S;
  const n = barT.length - 1;
  const i = clamp(Math.floor(b), 0, n - 1);
  return barT[i] + (b - i) * (barT[i + 1] - barT[i]);
}

export const totalBars = (barT: number[] | null, duration: number) => (barT ? barT.length - 1 : duration / NO_BARS_S);
const radiusAt = (b: number, total: number) => R_OUT - (R_OUT - R_IN) * clamp(b / Math.max(1, total), 0, 1);
/** How far round the record has turned at bar `b`, in radians, clockwise. */
const turnAt = (b: number) => (b / BARS_PER_TURN) * 2 * Math.PI;

/** Where the stylus sits (angle from the centre) when it's `r` from the centre. */
function stylusAngle(_r: number): number {
  return ARM_ANGLE;
}

/** A point of the groove at bar `b`, on the record before it turns. */
function groove(b: number, total: number): [number, number] {
  const r = radiusAt(b, total);
  const a = stylusAngle(r) - turnAt(b);
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

function groovePath(from: number, to: number, total: number): string {
  const a = clamp(from, 0, total);
  const b = clamp(to, 0, total);
  if (b - a < 0.01) return "";
  const n = Math.max(2, Math.ceil(((b - a) / BARS_PER_TURN) * 36));
  let d = "";
  for (let i = 0; i <= n; i++) {
    const [x, y] = groove(a + ((b - a) * i) / n, total);
    d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

/** The fling: once round the label, opening out, then away to the lower right. u: 0..1. */
function slingshot(r0: number, u: number): [number, number] {
  const a = stylusAngle(r0) + 6.6 * u;
  const r = r0 + (1100 - r0) * u ** 2.4;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

function slingPath(r0: number, u0: number, u1: number): string {
  let d = "";
  for (let i = 0; i <= 48; i++) {
    const [x, y] = slingshot(r0, u0 + ((u1 - u0) * i) / 48);
    d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The elements the turntable moves every frame, outside React (60 fps, no re-render). */
export interface TurntableRefs {
  group: SVGGElement | null;
  spiral: SVGPathElement | null;

  portal: SVGPathElement | null;
  arm: SVGLineElement | null;
  head: SVGLineElement | null;
  dot: SVGCircleElement | null;
  preview: SVGPathElement | null;
  ejectDot: SVGCircleElement | null;
  ejectTrail: SVGPathElement | null;
  time: HTMLDivElement | null;
}

export function useTurntable(player: Player, recordBox: RefObject<HTMLDivElement | null>, frozen: boolean) {
  const refs = useRef<TurntableRefs>({
    group: null, spiral: null, portal: null, arm: null, head: null, dot: null,
    preview: null, ejectDot: null, ejectTrail: null, time: null,
  }).current;
  const st = useRef({
    file: "", total: 1, shown: 0, last: 0, segStart: 0, segs: [] as [number, number][],
    ease: null as null | { from: number; to: number; t0: number },
    drag: null as null | { a: number; b0: number; turned: number; moved: boolean; id: number },
    target: 0, eject: null as null | { t0: number; r0: number }, frozen: false, spiralFile: "", portalAt: -1, ariaT: 0,
  }).current;
  st.frozen = frozen;

  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const tl = player.timeline();
      if (!tl) return;
      const total = totalBars(tl.barT, tl.duration);
      const actual = barFrac(tl.barT, player.position());
      if (tl.file !== st.file) {
        st.file = tl.file;
        st.total = total;
        st.segs = [];
        st.segStart = actual;
        st.ease = null;
        st.last = actual;
      } else if (Math.abs(actual - st.last) > 0.75 && !st.drag) {
        // A jump or a seek: the record swings to its new place, and the thread starts again there.
        st.segs = [...st.segs, [st.segStart, st.last] as [number, number]].slice(-16);
        st.segStart = actual;
        st.ease = still ? null : { from: st.shown, to: actual, t0: now };
      }
      st.last = actual;
      let shown = actual;
      if (st.drag?.moved) shown = st.target;
      else if (st.ease) {
        const k = (now - st.ease.t0) / EASE_MS;
        if (k >= 1) st.ease = null;
        else shown = st.ease.from + (actual - st.ease.from) * (1 - (1 - k) ** 3); // follows the song as it plays on
      }
      st.shown = shown;
      if (st.frozen) return; // the hands are carrying the records: leave this one as it was

      // The record: turned, its spiral, and the stretch already heard on this visit.
      refs.group?.setAttribute("transform", `rotate(${((turnAt(shown) * 180) / Math.PI) % 360} ${C} ${C})`);
      if (refs.spiral && st.spiralFile !== tl.file) {
        refs.spiral.setAttribute("d", groovePath(0, total, total));
        st.spiralFile = tl.file;
      }
      const s = player.state();
      const portal = s.next?.kind === "portal" ? s.next : null;
      if (refs.portal) {
        const at = portal ? portal.atBar : -1;
        if (at !== st.portalAt) {
          st.portalAt = at;
          if (at < 0) refs.portal.setAttribute("d", "");
          else {
            const r = radiusAt(at, total);
            const a = stylusAngle(r) - turnAt(at);
            const [cx, cy] = [Math.cos(a), Math.sin(a)];
            refs.portal.setAttribute("d", `M${C + (r - 9) * cx} ${C + (r - 9) * cy}L${C + (r + 9) * cx} ${C + (r + 9) * cy}`);
          }
        }
      }

      // The tonearm: in towards the label as the song goes on.
      const r = radiusAt(shown, total);
      const a = stylusAngle(r);
      const sx = C + r * Math.cos(a);
      const sy = C + r * Math.sin(a);
      refs.arm?.setAttribute("x2", sx.toFixed(1));
      refs.arm?.setAttribute("y2", sy.toFixed(1));
      if (refs.head) {
        const hx = C - sx; // the head points back along the arm, to the centre
        const hy = C - sy;
        const l = Math.hypot(hx, hy);
        refs.head.setAttribute("x1", sx.toFixed(1));
        refs.head.setAttribute("y1", sy.toFixed(1));
        refs.head.setAttribute("x2", (sx + (hx / l) * 30).toFixed(1));
        refs.head.setAttribute("y2", (sy + (hy / l) * 30).toFixed(1));
      }
      refs.dot?.setAttribute("cx", sx.toFixed(1));
      refs.dot?.setAttribute("cy", sy.toFixed(1));

      // The way out, drawn two bars before a portal.
      refs.preview?.setAttribute("d", portal && portal.inBars <= 2 && !st.eject ? slingPath(radiusAt(portal.atBar, total), 0.02, 0.6) : "");

      if (refs.time) {
        const sec = secondsAt(tl.barT, shown);
        refs.time.textContent = `${clock(sec)} / ${clock(tl.duration)}`;
      }
      const el = recordBox.current;
      if (el && now - st.ariaT > 500) {
        st.ariaT = now;
        const sec = secondsAt(tl.barT, shown);
        el.setAttribute("aria-valuemax", String(Math.round(tl.duration)));
        el.setAttribute("aria-valuenow", String(Math.round(sec)));
        el.setAttribute("aria-valuetext", `${clock(sec)} of ${clock(tl.duration)}`);
      }
    };
    let ejectRaf = 0;
    const ejectFrame = (now: number) => {
      ejectRaf = requestAnimationFrame(ejectFrame);
      const e = st.eject;
      if (!e) {
        refs.ejectDot?.setAttribute("r", "0");
        refs.ejectTrail?.setAttribute("d", "");
        return;
      }
      // Development only: window.saicsSlow = 10 plays it ten times slower, as with the crossing.
      const slow = import.meta.env.DEV ? ((window as unknown as { saicsSlow?: number }).saicsSlow ?? 1) : 1;
      const k = (now - e.t0) / (EJECT_MS * slow);
      if (k >= 1) {
        st.eject = null;
        return;
      }
      const u = k ** 1.5;
      const [x, y] = slingshot(e.r0, u);
      refs.ejectDot?.setAttribute("cx", x.toFixed(1));
      refs.ejectDot?.setAttribute("cy", y.toFixed(1));
      refs.ejectDot?.setAttribute("r", "15");
      refs.ejectTrail?.setAttribute("d", slingPath(e.r0, Math.max(0, u - 0.2), u));
    };
    raf = requestAnimationFrame(frame);
    ejectRaf = requestAnimationFrame(ejectFrame);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(ejectRaf);
    };
  }, [player, refs, st, recordBox]);

  /** A portal: the stylus is flung from where it is now. */
  const eject = useCallback(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    st.eject = { t0: performance.now(), r0: radiusAt(st.shown, st.total) };
  }, [st]);

  // ── turning the record by hand ──────────────────────────────────────────────

  const angleOf = (e: PointerEvent) => {
    const r = recordBox.current!.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const tl = player.timeline();
    if (!tl || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const b0 = barFrac(tl.barT, player.position()); // where the song really is, not the last frame drawn
    st.drag = { a: angleOf(e), b0, turned: 0, moved: false, id: e.pointerId };
    st.target = b0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, st]);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = st.drag;
    if (!d || d.id !== e.pointerId) return;
    const a = angleOf(e);
    let step = a - d.a;
    if (step > Math.PI) step -= 2 * Math.PI;
    if (step < -Math.PI) step += 2 * Math.PI;
    d.a = a;
    d.turned += step;
    if (!d.moved && Math.abs(d.turned) > 0.05) {
      d.moved = true; // a real turn, not a click: the hand stops the record
      player.hold(true);
    }
    st.target = clamp(d.b0 + (d.turned / (2 * Math.PI)) * BARS_PER_TURN, 0, st.total - 0.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, st]);

  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = st.drag;
    if (!d || d.id !== e.pointerId) return;
    st.drag = null;
    if (!d.moved) return;
    const tl = player.timeline();
    if (tl) {
      player.seek(secondsAt(tl.barT, st.target));
      st.segs = [];
      st.segStart = st.last = barFrac(tl.barT, player.position());
      st.shown = st.last;
    }
    player.hold(false);
  }, [player, st]);

  /** The record as a slider: arrows a bar, Page keys a turn (8 bars), Home the start. */
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const tl = player.timeline();
    if (!tl) return;
    const bars: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: BARS_PER_TURN, PageDown: -BARS_PER_TURN };
    const now = barFrac(tl.barT, player.position());
    let to: number | null = null;
    if (e.key in bars) to = Math.round(now) + bars[e.key];
    else if (e.key === "Home") to = 0;
    if (to == null) return;
    e.preventDefault();
    player.seek(to <= 0 ? 0 : secondsAt(tl.barT, Math.min(to, totalBars(tl.barT, tl.duration) - 1)));
  }, [player]);

  return { refs, eject, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown } };
}

/** The tonearm, the way out before a portal, and the fling itself: fixed, while the record turns. */
export function Arm({ refs, style, lifted }: { refs: TurntableRefs; style: CSSProperties; lifted: number }) {
  return (
    <svg className="arm" viewBox="0 0 600 600" style={style} aria-hidden="true">
      <path ref={(e) => void (refs.preview = e)} fill="none" stroke="var(--vermilion)" strokeWidth="2.5" strokeDasharray="7 9" />
      <g className="arm-body" opacity={1 - lifted}>
        <line ref={(e) => void (refs.arm = e)} x1={C} y1={C} x2={C + 280} y2={C} stroke="var(--paper)" strokeWidth="4" strokeLinecap="round" />
        <line ref={(e) => void (refs.head = e)} stroke="var(--paper)" strokeWidth="13" strokeLinecap="round" />
        <circle cx={C} cy={C} r="19" fill="var(--night)" stroke="var(--paper)" strokeWidth="4" />
        <circle ref={(e) => void (refs.dot = e)} r="7" fill="var(--vermilion)" />
      </g>
      <path ref={(e) => void (refs.ejectTrail = e)} fill="none" stroke="var(--vermilion)" strokeWidth="9" strokeLinecap="round" opacity="0.6" />
      <circle ref={(e) => void (refs.ejectDot = e)} r="0" fill="var(--vermilion)" />
    </svg>
  );
}
