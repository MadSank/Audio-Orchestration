import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";

import { addListener } from "../modules/saics-player";
import { color, font, space, type } from "./theme/tokens";

const DISC = 220;
const ARM_OUTER = 18; // tonearm angle (deg) at the start of the song (outer groove)
const ARM_INNER = 38; // ... at the end (next to the label)

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The record visualiser: the disc spins while playing, the tonearm tracks the position in the
 * song, and a Forever jump swings the arm back with a backwards scratch and a cyan flash
 * (amber = playback, cyan = jumps and transitions; CLAUDE.md design).
 */
export function Record({ position, duration, playing }: { position: number; duration: number; playing: boolean }) {
  const spin = useRef(new Animated.Value(0)).current;
  const scratch = useRef(new Animated.Value(0)).current;
  const arm = useRef(new Animated.Value(ARM_OUTER)).current;
  const flash = useRef(new Animated.Value(0)).current;
  const last = useRef({ position: 0, at: Date.now() });
  const [label, setLabel] = useState<string | null>(null);

  // Spin at 33 1/3 rpm while playing.
  useEffect(() => {
    if (!playing) return;
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 1800, easing: Easing.linear, useNativeDriver: true }),
    );
    spin.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [playing, spin]);

  function jumpBack(text: string | null) {
    setLabel(text);
    scratch.setValue(0);
    Animated.sequence([
      Animated.timing(scratch, { toValue: -2, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(scratch, { toValue: 0, duration: 0, useNativeDriver: true }), // -720 deg == 0: seamless
    ]).start();
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 2500, useNativeDriver: true }).start(() => setLabel(null));
  }

  // The engine reports each Forever jump ("C2:5 → C1:5 (avoid the ending)").
  useEffect(() => {
    const sub = addListener("onAction", (a: { action: string; detail?: string }) => {
      if (a.action === "jump") jumpBack(`↺ ${(a.detail ?? "").replace(/ \(.*\)$/, "")}`);
      if (a.action === "version") jumpBack(`⇄ ${a.detail ?? ""}`);
    });
    return () => sub.remove();
  }, []);

  // Tonearm follows the position; a backwards move (the jump executes a bar after it is
  // announced) springs the arm back instead of sliding.
  useEffect(() => {
    const frac = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
    const target = ARM_OUTER + (ARM_INNER - ARM_OUTER) * frac;
    const expected = last.current.position + (playing ? Date.now() - last.current.at : 0);
    const back = position < expected - 1500;
    last.current = { position, at: Date.now() };
    if (back) {
      Animated.spring(arm, { toValue: target, friction: 6, tension: 60, useNativeDriver: true }).start();
    } else {
      Animated.timing(arm, { toValue: target, duration: playing ? 1000 : 200, easing: Easing.linear, useNativeDriver: true }).start();
    }
  }, [position, duration, playing, arm]);

  const rotate = Animated.add(spin, scratch).interpolate({ inputRange: [-2, 1], outputRange: ["-720deg", "360deg"] });
  const armRotate = arm.interpolate({ inputRange: [0, 90], outputRange: ["0deg", "90deg"] });

  return (
    <View style={s.wrap}>
      <View style={s.stage}>
        <Animated.View style={[s.flash, { opacity: flash }]} />
        <Animated.View style={[s.disc, { transform: [{ rotate }] }]}>
          {[0.92, 0.8, 0.68, 0.56].map((k) => (
            <View key={k} style={[s.groove, { width: DISC * k, height: DISC * k, borderRadius: (DISC * k) / 2 }]} />
          ))}
          <View style={s.label}>
            <View style={s.labelMark} />
            <View style={s.hole} />
          </View>
        </Animated.View>
        <Animated.View style={[s.arm, { transform: [{ rotate: armRotate }] }]}>
          <View style={s.armBar} />
          <View style={s.head} />
        </Animated.View>
        <View style={s.pivot} />
      </View>
      <View style={s.bar}>
        <View style={[s.fill, { width: `${duration > 0 ? Math.min(100, (100 * position) / duration) : 0}%` }]} />
      </View>
      <View style={s.times}>
        <Text style={s.time}>{fmt(position)}</Text>
        {label ? <Text style={[s.time, { color: color.cyan }]} numberOfLines={1}>{label}</Text> : null}
        <Text style={s.time}>{duration > 0 ? fmt(duration) : "–:––"}</Text>
      </View>
    </View>
  );
}

const ARM_LEN = 150;
const s = StyleSheet.create({
  wrap: { gap: space.sm },
  stage: { width: DISC + 40, height: DISC + 20, alignSelf: "center", alignItems: "flex-start", justifyContent: "center" },
  flash: {
    position: "absolute", left: -6, top: 4, width: DISC + 12, height: DISC + 12, borderRadius: (DISC + 12) / 2,
    borderWidth: 3, borderColor: color.cyan,
  },
  disc: {
    width: DISC, height: DISC, borderRadius: DISC / 2, backgroundColor: "#111114",
    borderWidth: 1, borderColor: color.line, alignItems: "center", justifyContent: "center",
  },
  groove: { position: "absolute", borderWidth: 1, borderColor: "rgba(243,239,231,0.07)" },
  label: {
    width: DISC * 0.34, height: DISC * 0.34, borderRadius: DISC * 0.17, backgroundColor: color.amber,
    alignItems: "center", justifyContent: "center",
  },
  labelMark: { position: "absolute", top: 6, width: 4, height: 14, borderRadius: 2, backgroundColor: "#111" },
  hole: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.bg },
  arm: {
    position: "absolute", left: DISC + 20 - 3, top: 14, width: 6, height: ARM_LEN,
    transformOrigin: "50% 0%", alignItems: "center",
  },
  armBar: { width: 4, flex: 1, borderRadius: 2, backgroundColor: color.text },
  head: { width: 12, height: 20, borderRadius: 3, backgroundColor: color.text, marginTop: -2 },
  pivot: {
    position: "absolute", left: DISC + 20 - 11, top: 4, width: 22, height: 22, borderRadius: 11,
    backgroundColor: color.surfaceHi, borderWidth: 2, borderColor: color.text,
  },
  bar: { height: 4, borderRadius: 2, backgroundColor: color.line, overflow: "hidden" },
  fill: { height: 4, backgroundColor: color.amber },
  times: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  time: { ...type.mono, color: color.textMuted, fontFamily: font.mono, flexShrink: 1 },
});
