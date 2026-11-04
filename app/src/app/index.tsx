import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";

import SaicsPlayer from "../../modules/saics-player";
import { Disc, Folder, HeartLine, Infinity_, Moon, Play, Search, Sliders, VinylIcon } from "../icons";
import { Body, BottomNav, Display, IconBtn, Label, MiniPlayer, Mono, Pill, Title } from "../ui";
import { useLibrary, usePlayerState } from "../usePlayer";
import { color, font, radius, space } from "../theme/tokens";

export default function Home() {
  const router = useRouter();
  const state = usePlayerState();
  const { tracks, groups } = useLibrary();
  const hasFolder = !!SaicsPlayer.getFolder();

  function play(station: number) {
    SaicsPlayer.startStation(station).catch(() => {});
    router.push("/now-playing");
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={["top", "bottom"]}>
      <View style={s.header}>
        <View style={s.brand}>
          <Disc size={28} plate={null} />
          <Text style={s.brandText}>INFINITE RADIO</Text>
        </View>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <IconBtn border={color.border} onPress={() => router.replace("/library")} accessibilityLabel="Search"><Search size={20} c={color.text} /></IconBtn>
          <IconBtn border={color.border} onPress={() => router.replace("/buttons")} accessibilityLabel="Settings"><Sliders /></IconBtn>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.page}>
        <View style={s.hero}>
          <View style={{ flex: 1, gap: space.sm }}>
            <Label>STATION · LIBRARY-WIDE</Label>
            <Display size={30} style={{ lineHeight: 30 }}>INFINITE RIDE</Display>
            <Body style={{ lineHeight: 20 }}>Your whole library as one continuous walk, through portals between songs.</Body>
            <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
              <Pill kind="light" label="Play" icon={<Play size={16} c={color.bg} />} onPress={() => (state?.title && state.stationIndex === 0 ? router.push("/now-playing") : play(0))} />
              <Pill label="Shuffle" onPress={() => play(0)} />
            </View>
          </View>
          <HeroDisc />
        </View>

        <View style={s.rowBetween}>
          <Text style={s.h2}>STATIONS</Text>
          <Mono c={color.textFaint} style={{ flexShrink: 1 }}>Triple-press play to cycle</Mono>
        </View>

        <View style={s.grid}>
          <Tile icon={<Infinity_ size={28} c={color.cyan} />} title="This Song Forever" sub={state?.forever ? "On · seamless loop" : "Seamless infinite loop"} on={state?.forever}
            onPress={() => SaicsPlayer.toggleForever()} />
          <Tile icon={<VinylIcon />} title="Vinyl Ride" sub="The mix, on a turntable" on={state?.stationIndex === 1 && state.isPlaying} onPress={() => play(1)} />
          <Tile icon={<Moon size={28} c={color.lilac} />} title="Late Night" sub="Slowed + reverb" on={state?.stationIndex === 2 && state.isPlaying} onPress={() => play(2)} />
          <Tile icon={<HeartLine size={28} c={color.pink} />} title="Liked" sub="Only songs you hearted" on={state?.stationIndex === 3 && state.isPlaying} onPress={() => play(3)} />
        </View>

        <Pressable style={s.libraryCard} onPress={() => (hasFolder ? router.push("/groups") : router.replace("/buttons"))}>
          <Folder c={color.textMuted} />
          <View style={{ flex: 1 }}>
            <Title size={14}>{hasFolder ? `Library · ${groups.length} songs` : "Choose your music folder"}</Title>
            <Mono>{hasFolder ? `${tracks.length} versions in song groups` : "Needed before anything can play"}</Mono>
          </View>
          <Text style={{ fontFamily: font.bold, fontSize: 14, color: color.amber }}>{hasFolder ? "Review" : "Choose"}</Text>
        </Pressable>
      </ScrollView>

      <MiniPlayer state={state} />
      <BottomNav />
    </SafeAreaView>
  );
}

function HeroDisc() {
  return (
    <Svg width={104} height={104} viewBox="0 0 104 104">
      <Circle cx={52} cy={52} r={50} fill={color.bg} />
      {[46, 41, 36, 31].map((r) => <Circle key={r} cx={52} cy={52} r={r} fill="none" stroke={color.divider} strokeWidth={2} />)}
      <Path d="M52 6 A46 46 0 0 1 95 38" fill="none" stroke={color.amber} strokeWidth={3} strokeLinecap="round" />
      <Path d="M26 30 Q52 60 84 44 M30 74 Q52 48 70 82" fill="none" stroke={color.cyan} strokeWidth={1.5} strokeOpacity={0.8} />
      <Circle cx={52} cy={52} r={17} fill={color.amber} />
      <Circle cx={52} cy={52} r={2.5} fill={color.bg} />
    </Svg>
  );
}

function Tile({ icon, title, sub, on, onPress }: { icon: ReactNode; title: string; sub: string; on?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.tile, on && { borderColor: color.amber }, pressed && { opacity: 0.7 }]}>
      {icon}
      <View style={{ gap: 2 }}>
        <Text numberOfLines={1} style={{ fontFamily: font.extrabold, fontSize: 16, color: color.text }}>{title}</Text>
        <Body numberOfLines={1} style={{ fontSize: 13 }}>{sub}</Body>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.sm },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandText: { fontFamily: font.displayXb, fontSize: 15, letterSpacing: 0.6, color: color.text },
  page: { paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: space.md, gap: 14 },
  hero: { flexDirection: "row", alignItems: "center", gap: space.lg, padding: space.xl, borderRadius: radius.card, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  rowBetween: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md },
  h2: { fontFamily: font.displayXb, fontSize: 13, letterSpacing: 1, color: color.textMuted },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  tile: { width: "48%", flexGrow: 1, height: 98, padding: space.lg, justifyContent: "space-between", borderRadius: radius.tile, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  libraryCard: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 14, paddingHorizontal: space.lg, borderRadius: radius.row, borderWidth: 1, borderColor: color.border, borderStyle: "dashed" },
});
