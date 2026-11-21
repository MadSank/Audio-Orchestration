import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, Easing, Image, PanResponder, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, ClipPath, Defs, Line, Path } from "react-native-svg";

import SaicsPlayer, { addListener, readingNote, type Timeline } from "../../modules/saics-player";
import { displayName, versionLabel } from "../names";
import { Mono, Narrow, ObiTitle, PlayButton, Record, Serif, SkipButton, useK, useSpin, Word } from "../obi";
import { usePlayerState } from "../usePlayer";
import { color, OBI_WIDTH } from "../theme/tokens";
import { ARM, armDeg, barFrac, BARS_PER_TURN, groovePath, grooveTick, PIVOT, radiusAt, secondsAt, slingshot, totalBars, turnDeg } from "../turntable";

const HAND = [require("../../assets/hand/hand0.png"), require("../../assets/hand/hand1.png"), require("../../assets/hand/hand2.png")];
const GRIP = [require("../../assets/hand/grip0.png"), require("../../assets/hand/grip1.png"), require("../../assets/hand/grip2.png")];
/** Hand-drawn motion moves on twos: 8 positions a phase, about 12 a second. */
const onTwos = (t: number) => Math.floor(t * 8) / 8;
const SWING_MS = 380; // a jump or a seek: the record swings to its new place
const FLING_MS = 1150;
const AHEAD_S = 4; // the record is driven this far ahead between the service's state updates
/** The spindle in the middle: a stack that wears down as the song plays out (record units). */
const SPINDLE_MAX = 32;
const SPINDLE_MIN = 6;
const spindleAt = (b: number, tot: number) => SPINDLE_MIN + (SPINDLE_MAX - SPINDLE_MIN) * (1 - Math.max(0, Math.min(1, b / Math.max(1, tot))));

export default function NowPlaying() {
  const router = useRouter();
  const state = usePlayerState();
  const k = useK();
  const { width: W, height: H } = useWindowDimensions();
  const top = useSafeAreaInsets().top;
  const bottom = useSafeAreaInsets().bottom;
  const name = displayName(state?.title ?? "");
  const portal = state?.nextPortal ?? null;
  const uri = state?.versions?.[(state?.versionIndex ?? 1) - 1]?.uri;

  // ── the record ──────────────────────────────────────────────────────────────
  const D = 520 * k; // on screen its centre is at (70, 304) of the 390-wide layout
  const discTop = top + 44 * k;
  const discLeft = -190 * k;
  const spin = useSpin(!!state?.isPlaying); // the record coming in during a song change
  const rotate = spin.interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"] });

  // ── the record is the timeline ──────────────────────────────────────────────
  // It turns with the song (a turn every 8 bars) under a tonearm that moves in as it plays. Both run
  // on the native driver, aimed a few seconds ahead at each state update from the service.
  const songKey = `${state?.path ?? ""}|${state?.version ?? ""}`;
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const tl = useRef<Timeline | null>(null);
  tl.current = timeline;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const get = () => SaicsPlayer.getTimeline().then((t) => {
      if (!alive) return;
      setTimeline(t);
      if (t && !t.complete) timer = setTimeout(get, 3000); // the last bar settles once decoded
    }).catch(() => {});
    get();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [songKey]);
  const total = timeline ? totalBars(timeline.bars, timeline.duration) : 1;
  const turn = useRef(new Animated.Value(0)).current; // degrees, clockwise
  const arm = useRef(new Animated.Value(armDeg(radiusAt(0, 1)))).current;
  const sync = useRef({ pos: 0, at: 0, playing: false, key: "" });
  const seekTo = useRef<{ pos: number; t: number } | null>(null); // a seek the state hasn't caught up with
  const spindle = useRef(new Animated.Value(SPINDLE_MAX)).current; // radius, record units
  const dragging = useRef(false);
  const now = () => sync.current.pos + (sync.current.playing ? (Date.now() - sync.current.at) / 1000 : 0);
  const aim = useCallback((swing: boolean) => {
    const t = tl.current;
    if (!t) return;
    const tot = totalBars(t.bars, t.duration);
    const b = barFrac(t.bars, now());
    if (swing) {
      Animated.parallel([
        Animated.timing(turn, { toValue: turnDeg(b), duration: SWING_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(arm, { toValue: armDeg(radiusAt(b, tot)), duration: SWING_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(spindle, { toValue: spindleAt(b, tot), duration: SWING_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start(({ finished }) => finished && aim(false));
    } else if (sync.current.playing) {
      const ahead = barFrac(t.bars, now() + AHEAD_S);
      Animated.parallel([
        Animated.timing(turn, { toValue: turnDeg(ahead), duration: AHEAD_S * 1000, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(arm, { toValue: armDeg(radiusAt(ahead, tot)), duration: AHEAD_S * 1000, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(spindle, { toValue: spindleAt(ahead, tot), duration: AHEAD_S * 1000, easing: Easing.linear, useNativeDriver: true }),
      ]).start();
    } else {
      turn.stopAnimation();
      arm.stopAnimation();
      spindle.stopAnimation();
      turn.setValue(turnDeg(b));
      arm.setValue(armDeg(radiusAt(b, tot)));
      spindle.setValue(spindleAt(b, tot));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arm, spindle, turn]);
  useEffect(() => {
    if (!state || !timeline || dragging.current) return;
    const pos = state.position / 1000;
    const pending = seekTo.current;
    if (pending) {
      // Paused, the service makes the seek when play resumes: until then the record stays put.
      if (Math.abs(pos - pending.pos) < 1.5 || (state.isPlaying && Date.now() - pending.t > 4000)) seekTo.current = null;
      else return;
    }
    const expected = now();
    const fresh = sync.current.key !== songKey;
    sync.current = { pos, at: Date.now(), playing: state.isPlaying, key: songKey };
    const b = barFrac(timeline.bars, pos);
    if (fresh) {
      turn.stopAnimation();
      arm.stopAnimation();
      spindle.stopAnimation();
      turn.setValue(turnDeg(b));
      arm.setValue(armDeg(radiusAt(b, total)));
      spindle.setValue(spindleAt(b, total));
      aim(false);
    } else if (Math.abs(pos - expected) > 0.8) {
      aim(true); // a jump: the record swings back (or on)
    } else {
      aim(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, timeline]);
  const spiral = useMemo(() => (timeline ? groovePath(0, total, total) : ""), [timeline, total]);

  // ── the hand (a jump) ───────────────────────────────────────────────────────
  const hand = useRef(new Animated.Value(0)).current; // 0 off, 1 on the record, 2 dragged, 3 off
  const [handOn, setHandOn] = useState(false);
  const [frame, setFrame] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const giveUp = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushed = useRef(false);
  const [handDir, setHandDir] = useState<-1 | 1>(-1); // back in the song (pushed up, anticlockwise) or on
  const handDirRef = useRef(handDir);
  handDirRef.current = handDir;
  const handAt = useRef(0);
  const toHand = useCallback((to: number, ms: number, done?: () => void) => {
    handAt.current = to;
    Animated.timing(hand, { toValue: to, duration: ms, easing: onTwos, useNativeDriver: true }).start(() => done?.());
  }, [hand]);
  const leave = useCallback(() => {
    if (giveUp.current) clearTimeout(giveUp.current);
    toHand(3, 650, () => {
      hand.setValue(0);
      handAt.current = 0;
      setHandOn(false);
    });
  }, [hand, toHand]);
  const reach = useCallback((ms: number, then?: () => void) => {
    setHandOn(true);
    hand.setValue(0);
    toHand(1, ms, then);
  }, [hand, toHand]);
  // The push itself: the record swings with it, from the position the service reports after the jump.
  const drag = useCallback(() => {
    if (pushed.current) return;
    pushed.current = true;
    if (giveUp.current) clearTimeout(giveUp.current);
    if (pushAt.current) clearTimeout(pushAt.current);
    toHand(2, 700, () => setTimeout(leave, 250));
  }, [leave, toHand]);

  // ── the fling (a portal): the stylus goes round the label once and away ─────
  const flight = useRef(new Animated.Value(0)).current;
  const [flingFrom, setFlingFrom] = useState<number | null>(null); // the stylus's radius when it left
  const fling = useCallback(() => {
    const t = tl.current;
    if (!t) return;
    setFlingFrom(radiusAt(barFrac(t.bars, now()), totalBars(t.bars, t.duration)));
    flight.setValue(0);
    Animated.timing(flight, { toValue: 1, duration: FLING_MS, easing: Easing.linear, useNativeDriver: true }).start(() => setFlingFrom(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight]);

  // ── the portal (a change of song) ───────────────────────────────────────────
  const swap = useRef(new Animated.Value(0)).current;
  const [crossing, setCrossing] = useState<{ from: string; to: string; pair: string; landed: boolean } | null>(null);
  const crossingNow = !!crossing;
  const crossingRef = useRef(false);
  crossingRef.current = crossingNow;

  // ── turning the record by hand ──────────────────────────────────────────────
  // Holding it stops the sound (the service fades out and decides nothing); letting go plays on from
  // there, on the nearest downbeat. A tap does nothing. TalkBack: swipe up or down for a bar.
  const seekSec = useCallback((secs: number) => {
    void SaicsPlayer.seek(secs);
    seekTo.current = { pos: secs, t: Date.now() };
    sync.current = { ...sync.current, pos: secs, at: Date.now() };
    aim(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aim]);
  const scrubbing = useRef<{ a: number; b0: number; turned: number; moved: boolean; target: number } | null>(null);
  const cx = discLeft + D / 2;
  const cy = discTop + D / 2;
  const scrub = useMemo(() => {
    const letGo = () => {
      const d = scrubbing.current;
      scrubbing.current = null;
      if (!d?.moved) return;
      dragging.current = false;
      const t = tl.current;
      if (t) seekSec(secondsAt(t.bars, d.target));
      void SaicsPlayer.hold(false);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: (e) => !!tl.current && !crossingRef.current && Math.hypot(e.nativeEvent.pageX - cx, e.nativeEvent.pageY - cy) < D / 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const t = tl.current;
        if (!t) return;
        const b0 = barFrac(t.bars, now());
        scrubbing.current = { a: Math.atan2(e.nativeEvent.pageY - cy, e.nativeEvent.pageX - cx), b0, turned: 0, moved: false, target: b0 };
      },
      onPanResponderMove: (e) => {
        const d = scrubbing.current;
        const t = tl.current;
        if (!d || !t) return;
        const a = Math.atan2(e.nativeEvent.pageY - cy, e.nativeEvent.pageX - cx);
        let step = a - d.a;
        if (step > Math.PI) step -= 2 * Math.PI;
        if (step < -Math.PI) step += 2 * Math.PI;
        d.a = a;
        d.turned += step;
        if (!d.moved && Math.abs(d.turned) > 0.05) {
          d.moved = true; // a real turn, not a tap: the hand stops the record
          dragging.current = true;
          turn.stopAnimation();
          arm.stopAnimation();
          spindle.stopAnimation();
          void SaicsPlayer.hold(true);
        }
        if (!d.moved) return;
        const tot = totalBars(t.bars, t.duration);
        d.target = Math.max(0, Math.min(tot - 0.5, d.b0 + (d.turned / (2 * Math.PI)) * BARS_PER_TURN));
        turn.setValue(turnDeg(d.target));
        arm.setValue(armDeg(radiusAt(d.target, tot)));
        spindle.setValue(spindleAt(d.target, tot));
      },
      onPanResponderRelease: letGo,
      onPanResponderTerminate: letGo,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [D, cx, cy, seekSec]);
  const seekBars = (n: number) => {
    const t = tl.current;
    if (!t) return;
    const tot = totalBars(t.bars, t.duration);
    seekSec(secondsAt(t.bars, Math.max(0, Math.min(tot - 1, Math.round(barFrac(t.bars, now())) + n))));
  };

  // What the record shows: the song as a spiral and where a portal leaves; the way out is drawn two
  // bars before it. How far the song has got is the spindle, which wears down as it plays.
  const portalBar = portal?.kind === "portal" && state?.bar != null ? state.bar + portal.inBars : null;
  const grooves = useMemo(() => (timeline ? (
    <>
      <Path d={spiral} fill="none" stroke={color.grooveLit} strokeWidth={1.2} />
      {portalBar != null ? <Path d={grooveTick(portalBar, total)} stroke={color.vermilion} strokeWidth={4.5} strokeLinecap="round" /> : null}
    </>
  ) : undefined), [timeline, spiral, portalBar, total]);
  const toScreen = useCallback(([x, y]: [number, number]): [number, number] => [discLeft + x * k, discTop + y * k], [discLeft, discTop, k]);
  const wayOut = useMemo(() => {
    if (!timeline || portalBar == null || !portal || portal.inBars > 2 || flingFrom != null) return "";
    const r0 = radiusAt(portalBar, total);
    let d = "";
    for (let i = 0; i <= 40; i++) {
      const [x, y] = toScreen(slingshot(r0, 0.02 + (0.55 * i) / 40));
      d += `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  }, [timeline, portalBar, portal, flingFrom, total, toScreen]);
  const flingDots = useMemo(() => {
    if (flingFrom == null) return null;
    const N = 36;
    const ts = Array.from({ length: N + 1 }, (_, i) => i / N);
    const pts = ts.map((t) => toScreen(slingshot(flingFrom, t ** 1.5)));
    return [0, 0.05, 0.1].map((lag, j) => {
      const size = (j ? 10 - j * 2 : 14) * k;
      const inputRange = ts.map((t) => t + lag);
      return (
        <Animated.View key={j} pointerEvents="none" style={{
          position: "absolute", left: 0, top: 0, width: size, height: size, borderRadius: size / 2,
          backgroundColor: color.vermilion, opacity: j ? 0.55 - j * 0.15 : 1,
          transform: [
            { translateX: flight.interpolate({ inputRange, outputRange: pts.map((q) => q[0] - size / 2), extrapolate: "clamp" }) },
            { translateY: flight.interpolate({ inputRange, outputRange: pts.map((q) => q[1] - size / 2), extrapolate: "clamp" }) },
          ],
        }} />
      );
    });
  }, [flingFrom, flight, k, toScreen]);
  const turnRot = turn.interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"] });
  const armRot = arm.interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"] });
  const PAD = 24;

  useEffect(() => {
    if (!handOn && !crossingNow) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % HAND.length), 125);
    return () => clearInterval(id);
  }, [handOn, crossingNow]);
  const shownTitle = useRef("");
  const lastPair = useRef("");
  useEffect(() => { if (portal) lastPair.current = portal.pair; }, [portal]);
  useEffect(() => { if (!crossing && name.title) shownTitle.current = name.title; }, [crossing, name.title]);

  useEffect(() => {
    const visible = () => AppState.currentState === "active"; // nobody to draw for with the screen off
    const sub = addListener("onAction", (a) => {
      if (a.action === "version") {
        setFlash(versionLabel(a.detail ?? ""));
        setTimeout(() => setFlash(null), 2500);
      }
      if (!visible()) return;
      if (a.action === "jump-soon") {
        const [, dir, ms] = (a.detail ?? "").split("|");
        const inMs = Number(ms) || 600;
        setHandDir(dir === "1" ? 1 : -1);
        pushed.current = false;
        reach(Math.max(200, Math.min(600, inMs - 120)));
        if (pushAt.current) clearTimeout(pushAt.current);
        pushAt.current = setTimeout(drag, inMs); // the push lands on the downbeat the sound jumps on
        giveUp.current = setTimeout(leave, inMs + 5000); // the jump was dropped
      } else if (a.action === "jump") {
        setFlash(handDirRef.current === 1 ? "Jumping ahead" : "Jumping back");
        setTimeout(() => setFlash(null), 2500);
        if (!pushed.current) {
          if (handAt.current === 1) drag();
          else reach(320, drag);
        }
      } else if (a.action === "portal") {
        const [kind, ...title] = (a.detail ?? "").split("|");
        if (kind === "portal") fling();
        setCrossing({ from: shownTitle.current, to: displayName(title.join("|")).title, pair: kind === "portal" ? lastPair.current : "", landed: false });
        setTimeout(() => setCrossing((c) => c && { ...c, landed: true }), 2000); // while the strip is off-screen
        swap.setValue(0);
        Animated.timing(swap, { toValue: 1, duration: 3200, easing: Easing.linear, useNativeDriver: true }).start(() => {
          swap.setValue(0); // the record is back where it started, showing the new song
          setCrossing(null);
        });
      }
    });
    return () => {
      sub.remove();
      if (giveUp.current) clearTimeout(giveUp.current);
      if (pushAt.current) clearTimeout(pushAt.current);
    };
  }, [drag, fling, leave, reach, swap]);

  const lerp = (input: number[], output: number[]) => swap.interpolate({ inputRange: input, outputRange: output });
  const SHRINK = 380 / 520;
  // Always attached: a native-driven transform stays where it ended if its style is taken away.
  const outgoing = {
    transform: [
      { translateX: lerp([0, 0.14, 0.3, 0.62, 0.82, 1], [0, 0, 40 * k, 40 * k, 420 * k, 420 * k]) }, // carried off up the arm
      { translateY: lerp([0, 0.14, 0.3, 0.62, 0.82, 1], [0, 0, -134 * k, -134 * k, -760 * k, -760 * k]) },
      { scale: lerp([0, 0.14, 0.3, 1], [1, 1, SHRINK, SHRINK]) },
    ],
  };
  const incoming = {
    transform: [
      { translateX: lerp([0, 0.16, 0.32, 0.62, 0.84, 1], [550 * k, 550 * k, 210 * k, 210 * k, 0, 0]) },
      { translateY: lerp([0, 0.16, 0.32, 0.62, 0.84, 1], [476 * k, 476 * k, 86 * k, 86 * k, 0, 0]) },
      { scale: lerp([0, 0.62, 0.84, 1], [SHRINK, SHRINK, 1, 1]) },
    ],
  };
  // The two hands ride inside their records' views, so they carry them. Sizes are for the records'
  // held scale; (112, 130) of the 430 x 900 drawing is where the fingers meet the rim.
  const gripW = (430 * k) / SHRINK;
  const gripH = (900 * k) / SHRINK;
  const gripFrames = crossing ? GRIP.map((src, i) => (
    <Image key={i} source={src} fadeDuration={0} style={{ position: "absolute", width: gripW, height: gripH, opacity: frame === i ? 1 : 0 }} />
  )) : null;
  const holdOut = {
    position: "absolute" as const, left: 500 * k - (112 * k) / SHRINK, top: 150 * k - (130 * k) / SHRINK, width: gripW, height: gripH,
    transformOrigin: [(112 * k) / SHRINK, (130 * k) / SHRINK, 0],
    transform: [
      { translateX: lerp([0, 0.03, 0.16, 1], [340 * k, 340 * k, 0, 0]) },
      { translateY: lerp([0, 0.03, 0.16, 1], [-560 * k, -560 * k, 0, 0]) },
      { rotate: "-100deg" },
    ],
  };
  const holdIn = {
    position: "absolute" as const, left: 219 * k - (112 * k) / SHRINK, top: 513 * k - (130 * k) / SHRINK, width: gripW, height: gripH,
    transformOrigin: [(112 * k) / SHRINK, (130 * k) / SHRINK, 0],
    transform: [
      { translateX: lerp([0, 0.62, 0.76, 1], [0, 0, 420 * k, 420 * k]) }, // lets go once it has landed
      { translateY: lerp([0, 0.62, 0.76, 1], [0, 0, 700 * k, 700 * k]) },
      { rotate: "-10deg" },
    ],
  };
  const fade = (a: number, b: number, c: number, d: number) => lerp([0, a, b, c, d, 1].map((x, i, v) => (i && x <= v[i - 1] ? v[i - 1] + 0.0001 : x)), [0, 0, 1, 1, 0, 0]);

  const obiWidth = OBI_WIDTH * k;
  const obiH = H - 200 * k;
  const status = flash ?? (portal
    ? `${portal.kind === "cut" ? "Cut" : portal.kind === "back" ? "Back" : "Portal"} in ${portal.inBars} ${portal.inBars === 1 ? "bar" : "bars"}: ${displayName(portal.title).title}`
    : state?.title && state.jumpPoints == null ? `${readingNote(state.path, state.analysis)} · plays straight through`
    : state?.forever && state.jumpPoints === 0 ? "Forever · no loop points in this song"
    : state?.forever ? `Forever · ${state.jumps ?? 0} ${state.jumps === 1 ? "jump" : "jumps"}` : state?.station ?? "");

  return (
    <View style={{ flex: 1, backgroundColor: color.night, overflow: "hidden" }}>
      <Animated.View {...scrub.panHandlers} style={[{ position: "absolute", left: discLeft, top: discTop, width: D, height: D }, outgoing]}
        accessible={!!timeline} accessibilityRole="adjustable" accessibilityLabel="Place in the song: turn the record"
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => seekBars(e.nativeEvent.actionName === "increment" ? 1 : -1)}>
        <Animated.View style={{ transform: [{ rotate: timeline ? turnRot : rotate }] }}>
          <Record size={D} text={`${name.title} · `.repeat(3).slice(0, 44)} grooves={grooves} />
        </Animated.View>
        {timeline ? (
          <Animated.View pointerEvents="none" style={{
            position: "absolute", left: D / 2 - SPINDLE_MAX * k, top: D / 2 - SPINDLE_MAX * k,
            width: SPINDLE_MAX * 2 * k, height: SPINDLE_MAX * 2 * k, borderRadius: SPINDLE_MAX * k,
            backgroundColor: color.paper, borderWidth: 3 * k, borderColor: color.night,
            transform: [{ scale: spindle.interpolate({ inputRange: [0, SPINDLE_MAX], outputRange: [0, 1] }) }],
          }} />
        ) : null}
        {crossing ? <Animated.View pointerEvents="none" style={holdOut}>{gripFrames}</Animated.View> : null}
      </Animated.View>

      {crossing ? (
        <>
          <Animated.View style={[{ position: "absolute", left: discLeft, top: discTop, width: D, height: D }, incoming]}>
            <Animated.View style={{ transform: [{ rotate }] }}><Record size={D} /></Animated.View>
            <Animated.View pointerEvents="none" style={holdIn}>{gripFrames}</Animated.View>
          </Animated.View>
          <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: discTop - 44 * k, opacity: lerp([0, 0.3, 0.36, 0.44, 0.48, 0.52, 0.6, 0.66, 1], [0, 0, 1, 1, 0.75, 1, 1, 0, 0]) }}>
            <Svg width={390 * k} height={600 * k} viewBox="0 0 390 600">
              <Defs><ClipPath id="a"><Circle cx={110} cy={170} r={190} /></ClipPath></Defs>
              <Circle cx={280} cy={390} r={190} fill={color.vermilion} clipPath="url(#a)" />
            </Svg>
          </Animated.View>
        </>
      ) : null}

      {timeline ? (
        <Animated.View pointerEvents="none" style={{
          position: "absolute", left: discLeft + (PIVOT.x - PAD) * k, top: discTop + (PIVOT.y - PAD) * k,
          width: (ARM + PAD * 2) * k, height: PAD * 2 * k, transformOrigin: [PAD * k, PAD * k, 0],
          transform: [{ rotate: armRot }], opacity: lerp([0, 0.08, 0.84, 1], [1, 0, 0, 1]), // lifted while the records cross
        }}>
          <Svg width={(ARM + PAD * 2) * k} height={PAD * 2 * k} viewBox={`0 0 ${ARM + PAD * 2} ${PAD * 2}`}>
            <Line x1={PAD} y1={PAD} x2={PAD + ARM} y2={PAD} stroke={color.paper} strokeWidth={3.5} strokeLinecap="round" />
            <Line x1={PAD + ARM - 26} y1={PAD} x2={PAD + ARM} y2={PAD} stroke={color.paper} strokeWidth={11} strokeLinecap="round" />
            <Circle cx={PAD} cy={PAD} r={15} fill={color.night} stroke={color.paper} strokeWidth={3.5} />
            <Circle cx={PAD + ARM} cy={PAD} r={6} fill={color.vermilion} />
          </Svg>
        </Animated.View>
      ) : null}
      {wayOut ? (
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={W} height={H}>
          <Path d={wayOut} fill="none" stroke={color.vermilion} strokeWidth={2} strokeDasharray="6 8" />
        </Svg>
      ) : null}

      <Animated.View style={[StyleSheet.absoluteFill, { left: undefined, width: obiWidth }, { transform: [{ translateX: lerp([0, 0.12, 0.24, 0.72, 0.86, 1], [0, 0, 100 * k, 100 * k, 0, 0]) }] }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open versions" onPress={() => router.push("/versions")} style={[s.obi, { paddingTop: top + 26 * k, paddingBottom: bottom + 22 * k }]}>
          <View style={{ flex: 1, alignItems: "center" }}>
            <ObiTitle title={crossing ? (crossing.landed ? crossing.to : crossing.from) : name.title || "SAICS"} height={obiH * 0.74} />
          </View>
          <Mono c={color.night} style={{ textAlign: "center" }}>{state?.bpm ? Math.round(state.bpm) : ""}</Mono>
          <Mono c={color.night} style={{ textAlign: "center" }}>{state?.camelot ?? ""}</Mono>
        </Pressable>
      </Animated.View>

      <Pressable accessibilityRole="button" accessibilityLabel="Back to stations" onPress={() => router.back()} style={[s.back, { top: top + 4 }]}>
        <Serif size={26}>‹</Serif>
      </Pressable>

      <Pressable accessibilityRole="button" accessibilityLabel={state?.liked ? "Liked" : "Like"} accessibilityState={{ selected: !!state?.liked }} onPress={() => uri && SaicsPlayer.toggleLike(uri)}
        style={[s.heart, { top: top + 4, right: (OBI_WIDTH + 8) * k }]}>
        <Svg width={26} height={26} viewBox="0 0 24 24">
          <Path d="M12 20.5s-8-4.9-8-10.6C4 6.9 6.2 5 8.5 5c1.5 0 2.8.8 3.5 2 .7-1.2 2-2 3.5-2C17.8 5 20 6.9 20 9.9c0 5.7-8 10.6-8 10.6z"
            fill={state?.liked ? color.vermilion : "none"} stroke={state?.liked ? color.vermilion : color.paper} strokeWidth={2} strokeLinejoin="round" />
        </Svg>
      </Pressable>

      <Animated.View style={[s.body, { left: 24 * k, right: (OBI_WIDTH + 24) * k, bottom: bottom + 20 * k, opacity: lerp([0, 0.14, 0.26, 0.8, 0.92, 1], [1, 1, 0, 0, 1, 1]) }]}>
        <Serif size={32 * k} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{name.title || "Nothing playing"}</Serif>
        <Pressable accessibilityRole="button" accessibilityLabel="Open versions" onPress={() => router.push("/versions")} style={{ minHeight: 28, justifyContent: "center" }}>
          <Narrow numberOfLines={1}>{[name.artist, state?.version ? versionLabel(state.version) : ""].filter(Boolean).join(" · ")}</Narrow>
        </Pressable>
        <View style={s.statusRow}>
          <Mono style={{ flex: 1 }}>{status}</Mono>
          {portal && !flash ? <Word label="Stay" size={17} onPress={() => SaicsPlayer.stayPortal()} /> : null}
        </View>
        <View style={s.words}>
          <Word label="Forever" size={17} on={state?.forever} onPress={() => SaicsPlayer.toggleForever()} />
          <Word label="Vinyl" size={17} on={state?.vinyl} onPress={() => SaicsPlayer.toggleVinyl()} />
        </View>
        <View style={s.transport}>
          <SkipButton dir="prev" label="Previous" onPress={() => SaicsPlayer.previous()} />
          <PlayButton state={state} />
          <SkipButton dir="next" label="Next: once for the next portal, twice for a new song" onPress={() => SaicsPlayer.simulatePress("NEXT")} />
        </View>
      </Animated.View>

      {crossing ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "transparent", opacity: fade(0.28, 0.34, 0.62, 0.68) }]}>
          <View style={[s.crossCopy, { left: 24 * k, right: 170 * k, bottom: bottom + 20 * k }]}>
            <Serif size={30 * k} numberOfLines={2}>{crossing.pair ? "Same beat. New song." : "New song."}</Serif>
            {crossing.pair ? <Narrow numberOfLines={1}>{crossing.pair.replace("→", "into")}, on the downbeat</Narrow> : null}
          </View>
          <Serif size={25} numberOfLines={1} style={{ position: "absolute", left: 20 * k, width: 190 * k, top: top + 24 * k }}>{crossing.from}</Serif>
          <Serif size={25} numberOfLines={2} style={{ position: "absolute", left: 24 * k, width: 170 * k, top: top + 500 * k }}>{crossing.to}</Serif>
        </Animated.View>
      ) : null}

      {flingDots}

      {handOn ? (
        <Animated.View pointerEvents="none" style={{
          position: "absolute", left: 152 * k, top: top + 337 * k, width: 559 * k, height: 1170 * k,
          transformOrigin: [65 * k, 52 * k, 0],
          transform: [
            // pushed up (anticlockwise) for a jump back, pulled down for a jump on
            { translateX: hand.interpolate({ inputRange: [0, 1, 2, 3], outputRange: [170 * k, 0, handDir < 0 ? -17 * k : 26 * k, 200 * k] }) },
            { translateY: hand.interpolate({ inputRange: [0, 1, 2, 3], outputRange: [520 * k, 0, handDir < 0 ? -194 * k : 150 * k, 540 * k] }) },
            { rotate: hand.interpolate({ inputRange: [0, 1, 2, 3], outputRange: ["14deg", "0deg", handDir < 0 ? "-9deg" : "7deg", "16deg"] }) },
          ],
        }}>
          {HAND.map((src, i) => <Image key={i} source={src} fadeDuration={0} style={{ position: "absolute", width: 559 * k, height: 1170 * k, opacity: frame === i ? 1 : 0 }} />)}
        </Animated.View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  obi: { flex: 1, backgroundColor: color.vermilion, alignItems: "center" },
  back: { position: "absolute", left: 10, width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  heart: { position: "absolute", width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  body: { position: "absolute", gap: 2 },
  statusRow: { flexDirection: "row", alignItems: "center", minHeight: 28, gap: 8 },
  words: { flexDirection: "row", gap: 28 },
  transport: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  crossCopy: { position: "absolute", gap: 6, paddingTop: 12, paddingBottom: 120 },
});
