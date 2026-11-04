import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import SaicsPlayer from "../../modules/saics-player";
import { ChevronDown, Heart, HeartLine, Helmet, Infinity_, ListIcon, Next, Pause, Play, Prev } from "../icons";
import { displayName } from "../names";
import { Record } from "../Record";
import { Body, IconBtn, Label, Mono, Pill } from "../ui";
import { usePlayerState } from "../usePlayer";
import { color, font, radius, space } from "../theme/tokens";

export default function NowPlaying() {
  const router = useRouter();
  const state = usePlayerState();
  const name = displayName(state?.title ?? "");
  const portal = state?.nextPortal ?? null;
  const uri = state?.versions?.[(state?.versionIndex ?? 1) - 1]?.uri;
  const sections = state?.sections ?? [];
  const total = sections.reduce((n, x) => n + x.bars, 0);
  const versionLabel = state?.version ? state.version.replace(/\+/g, " + ") : "";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={["top", "bottom"]}>
      <View style={s.header}>
        <IconBtn onPress={() => router.back()} accessibilityLabel="Back to stations"><ChevronDown size={20} /></IconBtn>
        <View style={{ alignItems: "center" }}>
          <Label style={{ letterSpacing: 1.5 }}>PLAYING FROM</Label>
          <Text style={{ fontFamily: font.displayXb, fontSize: 14, color: color.text }}>{(state?.station ?? "").toUpperCase()}</Text>
        </View>
        <IconBtn onPress={() => router.push("/buttons")} accessibilityLabel="Helmet controls"><Helmet size={20} c={color.amber} /></IconBtn>
      </View>

      <ScrollView contentContainerStyle={s.page}>
        <Record position={state?.position ?? 0} duration={state?.duration ?? 0} playing={!!state?.isPlaying}
          bpm={state?.bpm ?? 0} camelot={state?.camelot ?? ""} sections={sections} />

        <View style={s.body}>
          <View style={s.titleRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={2} style={s.title}>{name.title || "Nothing playing"}</Text>
              {name.artist ? <Body numberOfLines={1} style={{ fontSize: 16 }}>{name.artist}</Body> : null}
              {state?.title && (state.versionCount ?? 0) > 0 ? (
                <Pressable onPress={() => router.push("/versions")} style={s.versionChip} accessibilityLabel="Open versions">
                  <Mono c={color.amber} bold>VERSION {state.versionIndex} OF {state.versionCount}</Mono>
                  <Mono bold style={{ flexShrink: 1 }}>· {versionLabel}</Mono>
                </Pressable>
              ) : null}
            </View>
            <IconBtn bg={color.surface} border={color.border} accessibilityLabel="Like" onPress={() => uri && SaicsPlayer.toggleLike(uri)}>
              {state?.liked ? <Heart size={20} c={color.pink} /> : <HeartLine size={20} c={color.pink} />}
            </IconBtn>
          </View>

          <View style={{ gap: 6 }}>
            <View style={s.strip}>
              {sections.map((x, i) => (
                <View key={i} style={{ flexGrow: x.bars, flexBasis: 0, borderRadius: 3, backgroundColor: x.kind === "chorus" ? color.amberDim : color.section }} />
              ))}
              {total > 0 && state?.bar != null ? (
                <View style={[s.cursor, { left: `${Math.min(100, (100 * Math.max(0, state.bar)) / total)}%` }]} />
              ) : null}
            </View>
            <View style={s.status}>
              <Mono style={{ flexShrink: 1 }}>{state?.sectionKind ? `${state.sectionKind.toUpperCase()} · ` : ""}{total > 0 ? `BAR ${Math.max(0, (state?.bar ?? 0)) + 1}/${total}` : ""}</Mono>
              {state?.forever ? <Mono c={color.cyan}>FOREVER · {state.jumps ?? 0} JUMPS</Mono> : null}
            </View>
          </View>

          {portal ? (
            <View style={s.portal}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Label c={color.cyan} style={{ letterSpacing: 1.1 }}>
                  {portal.kind === "portal" ? "PORTAL" : portal.kind === "back" ? "BACK" : "CUT"} IN {portal.inBars} {portal.inBars === 1 ? "BAR" : "BARS"} · {portal.pair.toUpperCase()}
                </Label>
                <Text numberOfLines={1} style={{ fontFamily: font.extrabold, fontSize: 16, color: color.text }}>{displayName(portal.title).title}</Text>
                <Mono>{Math.round(portal.bpm)} BPM · {portal.camelot} · lands at bar {portal.landBar + 1}</Mono>
              </View>
              <Pill kind="raised" label="Stay" onPress={() => SaicsPlayer.stayPortal()} />
            </View>
          ) : null}

          {(state?.versions?.length ?? 0) > 1 || state?.title ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
              <Pill h={40} kind={state?.vinyl ? "primary" : "outline"} label="Vinyl" onPress={() => SaicsPlayer.toggleVinyl()} />
              {state?.versions?.map((v) => (
                <Pill key={v.uri} h={40} kind={v.uri === uri ? "primary" : "outline"} label={v.version.replace(/\+/g, " + ")} onPress={() => SaicsPlayer.pickVersion(v.uri)} />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </ScrollView>

      <View style={s.transport}>
        <IconBtn size={48} bg="transparent" border={color.border} onPress={() => SaicsPlayer.toggleForever()} accessibilityLabel="Loop this song forever">
          <Infinity_ c={state?.forever ? color.cyan : color.textMuted} />
        </IconBtn>
        <IconBtn size={56} bg="transparent" onPress={() => SaicsPlayer.previous()} accessibilityLabel="Previous"><Prev size={28} /></IconBtn>
        <IconBtn size={80} bg={color.amber} onPress={() => SaicsPlayer.togglePlay()} accessibilityLabel={state?.isPlaying ? "Pause" : "Play"}>
          {state?.isPlaying ? <Pause size={30} c={color.amberInk} /> : <Play size={30} c={color.amberInk} />}
        </IconBtn>
        <IconBtn size={56} bg="transparent" onPress={() => SaicsPlayer.next()} accessibilityLabel="Take the next portal"><Next size={28} /></IconBtn>
        <IconBtn size={48} bg="transparent" border={color.border} onPress={() => router.push("/versions")} accessibilityLabel="All versions"><ListIcon c={color.textMuted} /></IconBtn>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs },
  page: { paddingBottom: space.sm, gap: space.xs },
  body: { paddingHorizontal: space.xl, gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "flex-end", gap: space.md },
  title: { fontFamily: font.black, fontSize: 26, lineHeight: 28, color: color.text },
  versionChip: { marginTop: 6, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 10, borderRadius: radius.chip, backgroundColor: color.surfaceRaised, borderWidth: 1, borderColor: color.border, maxWidth: "100%" },
  strip: { height: 10, flexDirection: "row", gap: 2 },
  cursor: { position: "absolute", top: -4, width: 4, height: 18, borderRadius: 2, backgroundColor: color.text },
  status: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  portal: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, paddingLeft: 14, paddingRight: space.md, borderRadius: 18, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  transport: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xxl, paddingTop: space.md, paddingBottom: space.lg },
});
