import { usePathname, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextProps, type TextStyle, type ViewStyle } from "react-native";

import SaicsPlayer, { type PlayerState } from "../modules/saics-player";
import { Disc, Helmet, LibraryIcon, Pause, Play, StationsIcon } from "./icons";
import { displayName } from "./names";
import { color, font, radius, space } from "./theme/tokens";

/** Screen title: Archivo expanded black, uppercase. */
export function Display({ size = 26, style, ...p }: TextProps & { size?: number }) {
  return <Text {...p} style={[{ fontFamily: font.display, fontSize: size, color: color.text }, style]} />;
}

export function Body({ style, ...p }: TextProps) {
  return <Text {...p} style={[{ fontFamily: font.regular, fontSize: 14, color: color.textMuted }, style]} />;
}

export function Title({ size = 15, style, ...p }: TextProps & { size?: number }) {
  return <Text numberOfLines={1} {...p} style={[{ fontFamily: font.bold, fontSize: size, color: color.text }, style]} />;
}

/** IBM Plex Mono data readout. */
export function Mono({ size = 12, c = color.textMuted, bold, style, ...p }: TextProps & { size?: number; c?: string; bold?: boolean }) {
  return <Text numberOfLines={1} {...p} style={[{ fontFamily: bold ? font.monoBold : font.mono, fontSize: size, color: c }, style]} />;
}

/** Small-caps section label. */
export function Label({ c = color.textMuted, style, ...p }: TextProps & { c?: string }) {
  return <Text numberOfLines={1} {...p} style={[{ fontFamily: font.monoMedium, fontSize: 11, letterSpacing: 1.3, color: c }, style]} />;
}

type PillKind = "primary" | "light" | "outline" | "raised";
const PILL: Record<PillKind, { bg: string; fg: string; border: string; fam: string }> = {
  primary: { bg: color.amber, fg: color.amberInk, border: color.amber, fam: font.extrabold },
  light: { bg: color.text, fg: color.bg, border: color.text, fam: font.extrabold },
  outline: { bg: "transparent", fg: color.text, border: color.border, fam: font.semibold },
  raised: { bg: color.surfaceRaised, fg: color.text, border: color.border, fam: font.bold },
};

/** Pill button (height/2 radius, >= 44 px target unless a chip). */
export function Pill({ label, kind = "outline", h = 44, icon, style, textStyle, ...p }: PressableProps & { label: string; kind?: PillKind; h?: number; icon?: ReactNode; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle> }) {
  const k = PILL[kind];
  return (
    <Pressable {...p} style={({ pressed }) => [s.pill, { height: h, borderRadius: h / 2, backgroundColor: k.bg, borderColor: k.border, opacity: pressed ? 0.7 : 1 }, style]}>
      {icon}
      <Text numberOfLines={1} style={[{ fontFamily: k.fam, fontSize: 14, color: k.fg }, textStyle]}>{label}</Text>
    </Pressable>
  );
}

/** Round icon button. */
export function IconBtn({ children, size = 44, bg = color.surface, border, style, ...p }: PressableProps & { children: ReactNode; size?: number; bg?: string; border?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable {...p} style={({ pressed }) => [s.icon, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg, opacity: pressed ? 0.7 : 1 }, border ? { borderWidth: 1, borderColor: border } : null, style]}>
      {children}
    </Pressable>
  );
}

export function Badge({ text, c = color.amber, bg = color.amberTint }: { text: string; c?: string; bg?: string }) {
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: bg }}>
      <Mono size={11} c={c} bold>{text}</Mono>
    </View>
  );
}

/** Mini player above the bottom nav: opens Now Playing. */
export function MiniPlayer({ state }: { state: PlayerState | null }) {
  const router = useRouter();
  if (!state?.title) return null;
  const portal = state.nextPortal;
  return (
    <Pressable onPress={() => router.push("/now-playing")} style={s.mini}>
      <View style={s.miniArt}><Disc size={30} plate={null} /></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Title>{displayName(state.title).title}</Title>
        <Mono c={portal ? color.cyan : color.textMuted}>
          {portal ? `portal into ${displayName(portal.title).title} · ${portal.inBars} bars` : `${state.station}${state.forever ? " · forever" : ""}`}
        </Mono>
      </View>
      <IconBtn bg={color.text} onPress={() => SaicsPlayer.togglePlay()} accessibilityLabel={state.isPlaying ? "Pause" : "Play"}>
        {state.isPlaying ? <Pause size={16} c={color.bg} /> : <Play size={16} c={color.bg} />}
      </IconBtn>
    </Pressable>
  );
}

const NAV = [
  { href: "/", label: "Stations", Icon: StationsIcon },
  { href: "/library", label: "Library", Icon: LibraryIcon },
  { href: "/buttons", label: "Helmet", Icon: Helmet },
] as const;

export function BottomNav() {
  const router = useRouter();
  const path = usePathname();
  return (
    <View style={s.nav}>
      {NAV.map(({ href, label, Icon }) => {
        const on = path === href;
        const c = on ? color.amber : color.textMuted;
        return (
          <Pressable key={href} onPress={() => !on && router.replace(href)} style={s.navItem} accessibilityRole="tab" accessibilityState={{ selected: on }}>
            <Icon size={22} c={c} />
            <Text style={{ fontFamily: on ? font.bold : font.semibold, fontSize: 12, color: c }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: 16, borderWidth: 1 },
  icon: { alignItems: "center", justifyContent: "center" },
  mini: { flexDirection: "row", alignItems: "center", gap: space.md, marginHorizontal: space.md, padding: 10, paddingLeft: space.md, borderRadius: radius.tile, backgroundColor: color.surfaceRaised },
  miniArt: { width: 44, height: 44, borderRadius: radius.list, backgroundColor: color.amberTint, alignItems: "center", justifyContent: "center" },
  nav: { flexDirection: "row", paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.sm, backgroundColor: color.bg },
  navItem: { flex: 1, height: 56, alignItems: "center", justifyContent: "center", gap: space.xs },
});
