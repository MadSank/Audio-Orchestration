import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, AppState, Easing, Image, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, ClipPath, Defs } from "react-native-svg";

import SaicsPlayer, { addListener } from "../../modules/saics-player";
import { displayName, versionLabel } from "../names";
import { Mono, Narrow, ObiTitle, PlayButton, Record, Serif, SkipButton, useK, useSpin, Word } from "../obi";
import { usePlayerState } from "../usePlayer";
import { color, OBI_WIDTH } from "../theme/tokens";

const HAND = [require("../../assets/hand/hand0.png"), require("../../assets/hand/hand1.png"), require("../../assets/hand/hand2.png")];
/** Hand-drawn motion moves on twos: 8 positions a phase, about 12 a second. */
const onTwos = (t: number) => Math.floor(t * 8) / 8;
const SCRATCH_DEG = -72;

export default function NowPlaying() {
  const router = useRouter();
  const state = usePlayerState();
  const k = useK();
  const { height: H } = useWindowDimensions();
  const top = useSafeAreaInsets().top;
  const bottom = useSafeAreaInsets().bottom;
  const name = displayName(state?.title ?? "");
  const portal = state?.nextPortal ?? null;
  const uri = state?.versions?.[(state?.versionIndex ?? 1) - 1]?.uri;

  // ── the record ──────────────────────────────────────────────────────────────
  const D = 520 * k; // on screen its centre is at (70, 304) of the 390-wide layout
  const discTop = top + 44 * k;
  const discLeft = -190 * k;
  const spin = useSpin(!!state?.isPlaying);
  const scratch = useRef(new Animated.Value(0)).current;
  const scratchAt = useRef(0);
  const rotate = Animated.add(spin, scratch).interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"] });

  // ── the hand (a jump) ───────────────────────────────────────────────────────
  const hand = useRef(new Animated.Value(0)).current; // 0 off, 1 on the record, 2 dragged, 3 off
  const [handOn, setHandOn] = useState(false);
  const [frame, setFrame] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const giveUp = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const drag = useCallback(() => {
    if (giveUp.current) clearTimeout(giveUp.current);
    scratchAt.current += SCRATCH_DEG;
    Animated.timing(scratch, { toValue: scratchAt.current, duration: 700, easing: onTwos, useNativeDriver: true }).start();
    toHand(2, 700, () => setTimeout(leave, 250));
  }, [leave, scratch, toHand]);

  useEffect(() => {
    if (!handOn) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % HAND.length), 125);
    return () => clearInterval(id);
  }, [handOn]);

  // ── the portal (a change of song) ───────────────────────────────────────────
  const swap = useRef(new Animated.Value(0)).current;
  const [crossing, setCrossing] = useState<{ from: string; to: string; pair: string; landed: boolean } | null>(null);
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
        reach(600);
        giveUp.current = setTimeout(leave, 5000); // the jump was dropped
      } else if (a.action === "jump") {
        setFlash("Jumping back");
        setTimeout(() => setFlash(null), 2500);
        if (handAt.current === 1) drag();
        else reach(320, drag);
      } else if (a.action === "portal") {
        const [kind, ...title] = (a.detail ?? "").split("|");
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
    };
  }, [drag, leave, reach, swap]);

  const lerp = (input: number[], output: number[]) => swap.interpolate({ inputRange: input, outputRange: output });
  const SHRINK = 380 / 520;
  // Always attached: a native-driven transform stays where it ended if its style is taken away.
  const outgoing = {
    transform: [
      { translateX: lerp([0, 0.14, 0.3, 0.62, 0.82, 1], [0, 0, 40 * k, 40 * k, -400 * k, -400 * k]) },
      { translateY: lerp([0, 0.14, 0.3, 0.62, 0.82, 1], [0, 0, -134 * k, -134 * k, -520 * k, -520 * k]) },
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
  const fade = (a: number, b: number, c: number, d: number) => lerp([0, a, b, c, d, 1].map((x, i, v) => (i && x <= v[i - 1] ? v[i - 1] + 0.0001 : x)), [0, 0, 1, 1, 0, 0]);

  const obiWidth = OBI_WIDTH * k;
  const obiH = H - 200 * k;
  const status = flash ?? (portal
    ? `${portal.kind === "cut" ? "Cut" : portal.kind === "back" ? "Back" : "Portal"} in ${portal.inBars} ${portal.inBars === 1 ? "bar" : "bars"}: ${displayName(portal.title).title}`
    : state?.forever ? `Forever · ${state.jumps ?? 0} ${state.jumps === 1 ? "jump" : "jumps"}` : state?.station ?? "");

  return (
    <View style={{ flex: 1, backgroundColor: color.night, overflow: "hidden" }}>
      <Animated.View style={[{ position: "absolute", left: discLeft, top: discTop, width: D, height: D }, outgoing]}>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Record size={D} text={`${name.title} · `.repeat(3).slice(0, 44)} />
        </Animated.View>
      </Animated.View>

      {crossing ? (
        <>
          <Animated.View style={[{ position: "absolute", left: discLeft, top: discTop, width: D, height: D }, incoming]}>
            <Animated.View style={{ transform: [{ rotate }] }}><Record size={D} /></Animated.View>
          </Animated.View>
          <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, top: discTop - 44 * k, opacity: lerp([0, 0.3, 0.36, 0.44, 0.48, 0.52, 0.6, 0.66, 1], [0, 0, 1, 1, 0.75, 1, 1, 0, 0]) }}>
            <Svg width={390 * k} height={600 * k} viewBox="0 0 390 600">
              <Defs><ClipPath id="a"><Circle cx={110} cy={170} r={190} /></ClipPath></Defs>
              <Circle cx={280} cy={390} r={190} fill={color.vermilion} clipPath="url(#a)" />
            </Svg>
          </Animated.View>
        </>
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
          <Word label={state?.liked ? "Liked" : "Like"} size={17} on={state?.liked} onPress={() => uri && SaicsPlayer.toggleLike(uri)} />
          <Word label="Ride" size={17} onPress={() => router.push("/ride")} />
        </View>
        <View style={s.transport}>
          <SkipButton dir="prev" label="Previous" onPress={() => SaicsPlayer.previous()} />
          <PlayButton state={state} />
          <SkipButton dir="next" label="Next: once for the next portal, twice for a new song" onPress={() => SaicsPlayer.simulatePress("NEXT")} />
        </View>
      </Animated.View>

      {crossing ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: "transparent", opacity: fade(0.28, 0.34, 0.62, 0.68) }]}>
          <View style={[s.crossCopy, { left: 24 * k, right: (OBI_WIDTH + 24) * k, bottom: bottom + 20 * k }]}>
            <Serif size={30 * k} numberOfLines={2}>{crossing.pair ? "Same beat. New song." : "New song."}</Serif>
            {crossing.pair ? <Narrow numberOfLines={1}>{crossing.pair.replace("→", "into")}, on the downbeat</Narrow> : null}
          </View>
          <Serif size={25} numberOfLines={1} style={{ position: "absolute", left: 20 * k, right: 150 * k, top: top + 24 * k }}>{crossing.from}</Serif>
          <Serif size={25} numberOfLines={1} style={{ position: "absolute", left: 150 * k, right: 20 * k, top: top + 536 * k, textAlign: "right" }}>{crossing.to}</Serif>
        </Animated.View>
      ) : null}

      {handOn ? (
        <Animated.View pointerEvents="none" style={{
          position: "absolute", left: 152 * k, top: top + 337 * k, width: 559 * k, height: 1170 * k,
          transformOrigin: [65 * k, 52 * k, 0],
          transform: [
            { translateX: hand.interpolate({ inputRange: [0, 1, 2, 3], outputRange: [170 * k, 0, -17 * k, 200 * k] }) },
            { translateY: hand.interpolate({ inputRange: [0, 1, 2, 3], outputRange: [520 * k, 0, -194 * k, 540 * k] }) },
            { rotate: hand.interpolate({ inputRange: [0, 1, 2, 3], outputRange: ["14deg", "0deg", "-9deg", "16deg"] }) },
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
  body: { position: "absolute", gap: 2 },
  statusRow: { flexDirection: "row", alignItems: "center", minHeight: 28, gap: 8 },
  words: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  transport: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  crossCopy: { position: "absolute", gap: 6, paddingTop: 12, paddingBottom: 120 },
});
