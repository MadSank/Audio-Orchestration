import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, useWindowDimensions, Vibration, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";

import SaicsPlayer from "../../modules/saics-player";
import { MiniRecord, Mono, Narrow, Serif, useK, Word } from "../obi";
import { useLibrary, usePlayerState } from "../usePlayer";
import { color } from "../theme/tokens";

type Stop = { name: string; line: string; index: number };
/** index -1 is the Forever switch, which rides the rim with the stations. */
const STOPS: Stop[] = [
  { name: "Infinite Ride", line: "Your whole library, one long walk through portals", index: 0 },
  { name: "Vinyl Ride", line: "The same walk, on a turntable", index: 1 },
  { name: "Late Night", line: "Slowed and reverb", index: 2 },
  { name: "Liked", line: "Only the songs you hearted", index: 3 },
  { name: "Forever", line: "Stay in this song, and loop it seamlessly", index: -1 },
];
const STEP = 26; // degrees between names on the rim
const SPAN = STEP * STOPS.length;

/** A stop's angle on the rim for this rotation, wrapped so that the names go round for ever. */
const wrap = (deg: number) => ((((deg + SPAN / 2) % SPAN) + SPAN) % SPAN) - SPAN / 2;

/** Stations as a disc: spin it to bring a station to the pointer, tap the name to play. */
export default function Stations({ onOpenHelmet }: { onOpenHelmet: () => void }) {
  const router = useRouter();
  const state = usePlayerState();
  const { tracks, groups } = useLibrary();
  const hasFolder = !!SaicsPlayer.getFolder();
  const k = useK();
  const { height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const CX = -120 * k;
  const CY = Math.round(H * 0.47);
  const R = 300 * k;

  const stationIndex = state?.stationIndex ?? 0;
  const rotation = useRef(new Animated.Value(-stationIndex * STEP)).current;
  const [deg, setDeg] = useState(-stationIndex * STEP);
  const at = useRef(deg);
  const dragging = useRef(false);
  const lastTick = useRef(Math.round(deg / STEP));

  useEffect(() => {
    const id = rotation.addListener(({ value }) => {
      at.current = value;
      setDeg(value);
    });
    return () => rotation.removeListener(id);
  }, [rotation]);

  // The helmet's triple press turns the dial too.
  useEffect(() => {
    if (dragging.current) return;
    const nearest = Math.round((at.current + stationIndex * STEP) / SPAN) * SPAN - stationIndex * STEP;
    Animated.spring(rotation, { toValue: nearest, useNativeDriver: false, friction: 8 }).start();
  }, [stationIndex, rotation]);

  const start = useRef({ angle: 0, deg: 0 });
  const angleOf = (x: number, y: number) => (Math.atan2(y - CY, x - CX) * 180) / Math.PI;
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      rotation.stopAnimation();
      dragging.current = true;
      start.current = { angle: angleOf(e.nativeEvent.pageX, e.nativeEvent.pageY), deg: at.current };
    },
    onPanResponderMove: (e) => {
      const next = start.current.deg + angleOf(e.nativeEvent.pageX, e.nativeEvent.pageY) - start.current.angle;
      rotation.setValue(next);
      const tick = Math.round(next / STEP);
      if (tick !== lastTick.current) {
        lastTick.current = tick;
        Vibration.vibrate(8);
      }
    },
    onPanResponderRelease: () => {
      dragging.current = false;
      Animated.spring(rotation, { toValue: Math.round(at.current / STEP) * STEP, useNativeDriver: false, friction: 7, tension: 60 }).start();
    },
    onPanResponderTerminate: () => {
      dragging.current = false;
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [CX, CY]);

  const grooves = useMemo(() => Array.from({ length: 14 }, (_, i) => 124 + i * 13), []);
  const D = 2 * (R + 24 * k);
  const ticks = useMemo(() => {
    let d = "";
    const C = D / 2;
    for (let t = 0; t < 360; t += 2) {
      const a = (t * Math.PI) / 180;
      const len = t % 10 === 0 ? 14 * k : 6 * k;
      d += `M${(C + (R + 6 * k) * Math.cos(a)).toFixed(1)} ${(C + (R + 6 * k) * Math.sin(a)).toFixed(1)}L${(C + (R + 6 * k + len) * Math.cos(a)).toFixed(1)} ${(C + (R + 6 * k + len) * Math.sin(a)).toFixed(1)}`;
    }
    return d;
  }, [D, R, k]);
  const spin = rotation.interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"] });

  function choose(stop: Stop) {
    if (stop.index < 0) {
      SaicsPlayer.toggleForever();
    } else if (stop.index === stationIndex && state?.title) {
      router.push("/now-playing");
    } else {
      SaicsPlayer.startStation(stop.index).catch(() => {});
      router.push("/now-playing");
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.night, overflow: "hidden" }}>
      <View style={{ position: "absolute", left: CX - D / 2, top: CY - D / 2, width: D, height: D }} {...pan.panHandlers}>
        <Animated.View style={{ transform: [{ rotate: spin }] }}>
          <Svg width={D} height={D}>
            <Circle cx={D / 2} cy={D / 2} r={R} fill={color.vinyl} />
            {grooves.map((r) => <Circle key={r} cx={D / 2} cy={D / 2} r={r * k} fill="none" stroke={color.groove} />)}
            <Path d={ticks} stroke="#6E6556" strokeWidth={1.5} />
            <Path d={`M${D / 2 + 150 * k} ${D / 2 - 90 * k} L${D / 2 + 262 * k} ${D / 2 - 118 * k} L${D / 2 + 262 * k} ${D / 2 - 40 * k} Z`} fill={color.paper} opacity={0.05} />
            <Path d={`M${D / 2 + 90 * k} ${D / 2 + 150 * k} L${D / 2 + 118 * k} ${D / 2 + 262 * k} L${D / 2 + 40 * k} ${D / 2 + 262 * k} Z`} fill={color.paper} opacity={0.05} />
            <Circle cx={D / 2} cy={D / 2} r={108 * k} fill={color.vermilion} />
          </Svg>
        </Animated.View>
      </View>
      <Svg pointerEvents="none" width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Path d={`M${60 * k} ${CY} L${178 * k} ${CY}`} stroke={color.vermilion} strokeWidth={4} strokeLinecap="round" />
      </Svg>

      <View style={{ position: "absolute", left: 24, right: 24, top: insets.top + 18 }}>
        <Serif size={44 * k}>Tune in</Serif>
        <Mono style={{ marginTop: 4 }}>
          {hasFolder ? `${groups.length} SONGS · ${tracks.length} VERSIONS` : "NO MUSIC FOLDER YET"}
        </Mono>
        {!hasFolder ? <Word label="Choose your music folder" size={19} on onPress={onOpenHelmet} /> : null}
      </View>

      {STOPS.map((stop, i) => {
        const angle = wrap(i * STEP + deg);
        const closeness = Math.max(0, 1 - Math.abs(angle) / (STEP / 2));
        const fade = Math.max(0, Math.min(1, (SPAN / 2 - Math.abs(angle)) / 12));
        const a = (angle * Math.PI) / 180;
        const x = Math.round(CX + (R + 30 * k) * Math.cos(a));
        const y = Math.round(CY + (R + 30 * k) * Math.sin(a));
        const tuned = closeness > 0.5;
        const lit = stop.index < 0 ? !!state?.forever : tuned;
        return (
          <Pressable key={stop.name} accessibilityRole="button" accessibilityState={{ selected: lit }} onPress={() => tuned && choose(stop)}
            style={[s.stop, { left: x, top: y - 24 - (tuned ? 20 : 0), width: Math.max(0, 390 * k - x - 12), opacity: fade }]}>
            <Serif size={(22 + 12 * closeness) * k} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} c={lit ? color.vermilion : color.paper}>{stop.name}</Serif>
            {tuned ? <Narrow size={15} numberOfLines={2}>{stop.line}</Narrow> : null}
          </Pressable>
        );
      })}

      <View style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 14 }}>
        <MiniRecord state={state} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  stop: { position: "absolute", minHeight: 48, justifyContent: "center" },
});
