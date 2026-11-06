import { useRouter } from "expo-router";
import { memo, useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, useWindowDimensions, View, type PressableProps, type StyleProp, type TextProps, type ViewStyle } from "react-native";
import Svg, { Circle, Defs, Path, Text as SvgText, TextPath } from "react-native-svg";

import SaicsPlayer, { type PlayerState } from "../modules/saics-player";
import { displayName } from "./names";
import { color, font, OBI_WIDTH, target } from "./theme/tokens";

/** Layouts are drawn for a 390-wide screen; this scales them to the phone. */
export function useK(): number {
  return useWindowDimensions().width / 390;
}

export function Serif({ size = 22, c = color.paper, style, ...p }: TextProps & { size?: number; c?: string }) {
  return <Text {...p} style={[{ fontFamily: font.serif, fontSize: size, lineHeight: size * 1.16, color: c }, style]} />;
}

export function Narrow({ size = 17, c = color.paperDim, bold, style, ...p }: TextProps & { size?: number; c?: string; bold?: boolean }) {
  return <Text {...p} style={[{ fontFamily: bold ? font.narrowBold : font.narrow, fontSize: size, color: c }, style]} />;
}

export function Mono({ size = 12, c = color.paperDim, style, ...p }: TextProps & { size?: number; c?: string }) {
  return <Text numberOfLines={1} {...p} style={[{ fontFamily: font.mono, fontSize: size, color: c }, style]} />;
}

/** The only kind of button text: a serif word you tap, vermilion when it's on. */
export function Word({ label, on, size = 20, style, ...p }: PressableProps & { label: string; on?: boolean; size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!on }} {...p}
      style={({ pressed }) => [{ minHeight: target.min, justifyContent: "center", opacity: pressed ? 0.6 : 1 }, style]}>
      <Serif size={size} c={on ? color.vermilion : color.paper} numberOfLines={1}>{label}</Serif>
    </Pressable>
  );
}

/** The record's label takes the key's colour in the crate and portals, never on Now Playing. */
export function keyColor(camelot: string | undefined): string {
  const n = parseInt(camelot ?? "", 10);
  if (!n) return color.unread;
  const major = camelot!.endsWith("B");
  return `hsl(${(n * 30 + 330) % 360}, ${major ? 85 : 68}%, ${major ? 62 : 54}%)`;
}

const GROOVES = Array.from({ length: 14 }, (_, i) => 96 + i * 11);

/** A record, drawn on a 520-wide grid. Static: spinning it is only a transform. */
export const Record = memo(function Record({ size, label = color.vermilion, text }: { size: number; label?: string; text?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 520 520">
      <Circle cx={260} cy={260} r={258} fill={color.vinyl} />
      {GROOVES.map((r) => <Circle key={r} cx={260} cy={260} r={r} fill="none" stroke={color.grooveLit} strokeWidth={1} />)}
      <Path d="M260 2 A258 258 0 0 1 480 125 L260 260 Z" fill={color.paper} opacity={0.05} />
      <Path d="M260 518 A258 258 0 0 1 40 395 L260 260 Z" fill={color.paper} opacity={0.05} />
      <Circle cx={260} cy={260} r={84} fill={label} />
      {text ? (
        <>
          <Defs><Path id="label" d="M260 196 a64 64 0 1 1 -0.1 0" /></Defs>
          <SvgText fontFamily={font.narrowBold} fontSize={17} letterSpacing={2} fill={color.night}>
            <TextPath href="#label">{text}</TextPath>
          </SvgText>
        </>
      ) : null}
      <Circle cx={260} cy={260} r={7} fill={color.night} />
    </Svg>
  );
});

/** Degrees that advance while playing and hold while paused, for one turn every five seconds. */
export function useSpin(playing: boolean): Animated.Value {
  const spin = useRef(new Animated.Value(0)).current;
  const at = useRef(0);
  useEffect(() => {
    const id = spin.addListener(({ value }) => { at.current = value; });
    return () => spin.removeListener(id);
  }, [spin]);
  useEffect(() => {
    if (!playing) {
      spin.stopAnimation();
      return;
    }
    let live = true;
    const turn = () => {
      if (!live) return;
      const from = at.current % 360;
      spin.setValue(from);
      Animated.timing(spin, { toValue: 360, duration: ((360 - from) / 360) * 5000, easing: Easing.linear, useNativeDriver: true })
        .start(({ finished }) => {
          if (finished) {
            at.current = 0;
            turn();
          }
        });
    };
    turn();
    return () => {
      live = false;
      spin.stopAnimation();
    };
  }, [playing, spin]);
  return spin;
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** The obi's title: stacked characters for Japanese or Korean, a turned line for anything else. */
export function ObiTitle({ title, height, ink = color.night }: { title: string; height: number; ink?: string }) {
  const k = useK();
  if (CJK.test(title)) {
    const chars = [...title.replace(/\s+/g, "")].slice(0, 12);
    const size = Math.min(46 * k, height / Math.max(chars.length, 1) / 1.12);
    return (
      <View style={{ alignItems: "center" }}>
        {chars.map((ch, i) => <Text key={i} style={{ fontFamily: font.serif, fontSize: size, lineHeight: size * 1.12, color: ink, includeFontPadding: false }}>{ch}</Text>)}
      </View>
    );
  }
  const across = OBI_WIDTH * k;
  return (
    <View style={{ width: across, height, alignItems: "center", justifyContent: "center" }}>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}
        style={{ width: height, height: across, textAlign: "left", textAlignVertical: "center", fontFamily: font.serif, fontSize: 44 * k, color: ink, includeFontPadding: false, transform: [{ rotate: "90deg" }] }}>
        {title.toUpperCase()}
      </Text>
    </View>
  );
}

const Icon = ({ d, size, c }: { d: string; size: number; c: string }) => (
  <Svg width={size} height={size} viewBox="0 0 26 26"><Path d={d} fill={c} stroke={c} strokeWidth={1} /></Svg>
);
const PAUSE = "M6 4h5v18H6zM15 4h5v18h-5z";
const PLAY = "M7 3.5l15 9.5-15 9.5z";
const PREV = "M5 4v18M22 4L8 13l14 9z";
const NEXT = "M21 4v18M4 4l14 9-14 9z";

export function PlayButton({ state, size = 76, bg = color.paper, ink = color.night }: { state: PlayerState | null; size?: number; bg?: string; ink?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={state?.isPlaying ? "Pause" : "Play"} onPress={() => SaicsPlayer.togglePlay()}
      style={({ pressed }) => ({ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.7 : 1 })}>
      <Icon d={state?.isPlaying ? PAUSE : PLAY} size={size * 0.34} c={ink} />
    </Pressable>
  );
}

export function SkipButton({ dir, onPress, label, size = 56 }: { dir: "prev" | "next"; onPress: () => void; label: string; size?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({ width: size, height: size, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}>
      <Icon d={dir === "prev" ? PREV : NEXT} size={26} c={color.paper} />
    </Pressable>
  );
}

/** What's playing, as a small record and its title. Tap for Now Playing. */
export function MiniRecord({ state }: { state: PlayerState | null }) {
  const router = useRouter();
  if (!state?.title) return null;
  const portal = state.nextPortal;
  return (
    <View style={s.mini}>
      <Pressable accessibilityRole="button" accessibilityLabel="Open Now Playing" onPress={() => router.push("/now-playing")} style={s.miniOpen}>
        <Record size={58} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Serif size={19} numberOfLines={1}>{displayName(state.title).title}</Serif>
          <Mono>{portal ? `Portal in ${portal.inBars} ${portal.inBars === 1 ? "bar" : "bars"}` : state.forever ? "Forever" : state.station}</Mono>
        </View>
      </Pressable>
      <PlayButton state={state} size={56} />
    </View>
  );
}

const s = StyleSheet.create({
  mini: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 24 },
  miniOpen: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 14 },
});
