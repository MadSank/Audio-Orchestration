import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import { addListener, type SectionInfo } from "../modules/saics-player";
import { displayName, versionLabel } from "./names";
import { Mono } from "./ui";
import { color, font } from "./theme/tokens";

const STAGE = 300;
const C = STAGE / 2;
const DISC = 268;
const RING = 144; // section arcs on the outer ring
const ARM_OUTER = 5; // tonearm angle (deg) at the start of the song (outer groove)
const ARM_INNER = 26; // ... at the end (next to the label)

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const pt = (f: number, r: number) => {
  const a = (-90 + f * 360) * (Math.PI / 180);
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
};
function arc(f0: number, f1: number, r: number) {
  const a = pt(f0, r);
  const b = pt(Math.min(f1, 0.9999), r);
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${r} ${r} 0 ${f1 - f0 > 0.5 ? 1 : 0} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)} `;
}

/**
 * The record visualiser: the disc spins while playing, the tonearm tracks the position in the
 * song and swings back on a jump (with a backwards scratch and a cyan flash). Section arcs and
 * the played portion ring the disc, as in design 02. Amber = playback, cyan = jumps/transitions.
 */
export function Record({ position, duration, playing, bpm, camelot, sections }: {
  position: number; duration: number; playing: boolean; bpm: number; camelot: string; sections: SectionInfo[];
}) {
  const spin = useRef(new Animated.Value(0)).current;
  const scratch = useRef(new Animated.Value(0)).current;
  const arm = useRef(new Animated.Value(ARM_OUTER)).current;
  const flash = useRef(new Animated.Value(0)).current;
  const last = useRef({ position: 0, at: Date.now() });
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!playing) return;
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1800, easing: Easing.linear, useNativeDriver: true }),
    ); // 33 1/3 rpm
    spin.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [playing, spin]);

  function jumpBack(text: string) {
    setLabel(text);
    scratch.setValue(0);
    Animated.sequence([
      Animated.timing(scratch, { toValue: -2, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(scratch, { toValue: 0, duration: 0, useNativeDriver: true }), // -720 deg == 0: seamless
    ]).start();
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 2500, useNativeDriver: true }).start(() => setLabel(null));
  }

  useEffect(() => {
    const sub = addListener("onAction", (a) => {
      if (a.action === "jump") jumpBack(`↺ ${(a.detail ?? "").replace(/ \(.*\)$/, "")}`);
      if (a.action === "portal") jumpBack(`→ ${displayName(a.detail ?? "").title}`);
      if (a.action === "version") jumpBack(`⇄ ${versionLabel(a.detail ?? "")}`);
    });
    return () => sub.remove();
  }, []);

  const frac = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  useEffect(() => {
    const target = ARM_OUTER + (ARM_INNER - ARM_OUTER) * frac;
    const expected = last.current.position + (playing ? Date.now() - last.current.at : 0);
    const back = position < expected - 1500;
    last.current = { position, at: Date.now() };
    if (back) {
      Animated.spring(arm, { toValue: target, friction: 6, tension: 60, useNativeDriver: true }).start();
    } else {
      Animated.timing(arm, { toValue: target, duration: playing ? 1000 : 200, easing: Easing.linear, useNativeDriver: true }).start();
    }
  }, [position, frac, playing, arm]);

  const rotate = Animated.add(spin, scratch).interpolate({ inputRange: [-2, 1], outputRange: ["-720deg", "360deg"] });
  const armRotate = arm.interpolate({ inputRange: [0, 90], outputRange: ["0deg", "90deg"] });

  const total = sections.reduce((n, x) => n + x.bars, 0) || 1;
  let chorus = "";
  let other = "";
  let at = 0;
  for (const x of sections) {
    const d = arc((at + 0.25) / total, (at + x.bars - 0.25) / total, RING);
    if (x.kind === "chorus") chorus += d;
    else other += d;
    at += x.bars;
  }
  if (!sections.length) other = arc(0, 0.9999, RING);

  return (
    <View style={s.wrap}>
      <View style={s.stage}>
        <Svg width={STAGE} height={STAGE} style={StyleSheet.absoluteFill}>
          <Circle cx={C} cy={C} r={C - 1} fill={color.disc} />
          <Path d={other} fill="none" stroke={color.section} strokeWidth={5} />
          <Path d={chorus} fill="none" stroke={color.amberDim} strokeWidth={5} />
          {frac > 0.002 ? <Path d={arc(0, frac, RING)} fill="none" stroke={color.amber} strokeWidth={5} strokeLinecap="round" /> : null}
        </Svg>
        <Animated.View style={[s.flash, { opacity: flash }]} />
        <Animated.View style={[s.disc, { transform: [{ rotate }] }]}>
          <Svg width={DISC} height={DISC}>
            {[58, 70, 82, 94, 106, 118, 130].map((r) => (
              <Circle key={r} cx={DISC / 2} cy={DISC / 2} r={r} fill="none" stroke={color.groove} strokeWidth={1.6} />
            ))}
            {/* the sheen: shows the spin and the scratch */}
            <Path d="M134 14 A120 120 0 0 1 238 74" fill="none" stroke="#FFFFFF" strokeOpacity={0.06} strokeWidth={20} />
          </Svg>
        </Animated.View>
        <View style={s.label} pointerEvents="none">
          <Mono size={13} c={color.amberInk} bold>{bpm > 0 ? `${Math.round(bpm)} BPM` : " "}</Mono>
          <Mono size={13} c={color.amberInk} bold>{camelot || " "}</Mono>
        </View>
        <Animated.View style={[s.arm, { transform: [{ rotate: armRotate }] }]} pointerEvents="none">
          <View style={s.armBar} />
          <View style={s.head} />
        </Animated.View>
        <View style={s.pivot} />
      </View>
      <View style={s.times}>
        <Mono>{fmt(position)}</Mono>
        {label ? <Mono c={color.cyan} style={{ flexShrink: 1, fontFamily: font.monoMedium }}>{label}</Mono> : null}
        <Mono>{duration > 0 ? fmt(duration) : "–:––"}</Mono>
      </View>
    </View>
  );
}

const ARM_LEN = 178;
const s = StyleSheet.create({
  wrap: { alignSelf: "stretch", gap: 2 },
  stage: { width: STAGE, height: STAGE, alignSelf: "center", alignItems: "center", justifyContent: "center" },
  flash: { position: "absolute", width: STAGE, height: STAGE, borderRadius: C, borderWidth: 3, borderColor: color.cyan },
  disc: { width: DISC, height: DISC },
  label: { position: "absolute", width: 92, height: 92, borderRadius: 46, backgroundColor: color.amber, alignItems: "center", justifyContent: "center", gap: 2 },
  arm: { position: "absolute", left: STAGE - 22, top: 9, width: 6, height: ARM_LEN, transformOrigin: "50% 0%", alignItems: "center" },
  armBar: { width: 3, flex: 1, borderRadius: 2, backgroundColor: color.text },
  head: { width: 10, height: 18, borderRadius: 3, backgroundColor: color.text, marginTop: -2 },
  pivot: { position: "absolute", left: STAGE - 29, top: 0, width: 20, height: 20, borderRadius: 10, backgroundColor: color.surfaceRaised, borderWidth: 2, borderColor: color.text },
  times: { flexDirection: "row", justifyContent: "space-between", gap: 8, paddingHorizontal: 20 },
});
