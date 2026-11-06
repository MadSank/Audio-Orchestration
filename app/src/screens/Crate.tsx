import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";

import SaicsPlayer, { type PortalGroup, type Track } from "../../modules/saics-player";
import { artistLine, displayName, versionLabel } from "../names";
import { keyColor, MiniRecord, Mono, Narrow, Serif, useK, Word } from "../obi";
import { type SongGroup, useLibrary, usePlayerState } from "../usePlayer";
import { color, font } from "../theme/tokens";

type Filter = "all" | "key" | "tempo" | "pending";
const FILTERS: [Filter, string][] = [["all", "All"], ["key", "By key"], ["tempo", "By tempo"], ["pending", "Unread"]];
const ROW = 86;
const main = (g: SongGroup) => g.versions.find((v) => v.version === "original") ?? g.versions[0];
/** For searching: lower case, with accents and punctuation out, so "deja vu" finds "Déjà-Vu". */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Records leaning out of a crate: they follow a slow curve down the screen, with no lines between. */
export default function Crate() {
  const router = useRouter();
  const state = usePlayerState();
  const { tracks, groups, loading } = useLibrary();
  const k = useK();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [portals, setPortals] = useState<PortalGroup[]>([]);

  const trackId = state?.trackId;
  useEffect(() => {
    if (trackId) SaicsPlayer.getPortalsFrom(trackId).then(setPortals).catch(() => setPortals([]));
    else setPortals([]);
  }, [trackId]);

  const shown = useMemo(() => {
    const words = fold(q).split(" ").filter(Boolean);
    let out = groups;
    if (words.length) {
      // Every word has to appear somewhere in the song: its name, a version, a key or a tempo.
      out = out.filter((g) => {
        const text = fold([g.name, ...g.versions.flatMap((v) => [v.title, v.version, v.file, v.camelot, v.bpm ? String(Math.round(v.bpm)) : ""])].join(" "));
        return words.every((w) => text.includes(w));
      });
    }
    if (filter === "pending") out = out.filter((g) => g.versions.every((v) => !v.trackId));
    if (filter === "key") out = [...out].sort((a, b) => main(a).camelot.localeCompare(main(b).camelot, undefined, { numeric: true }));
    if (filter === "tempo") out = [...out].sort((a, b) => main(a).bpm - main(b).bpm);
    return out;
  }, [groups, q, filter]);

  const header = portals.length > 0 && !q ? (
    <View style={{ paddingHorizontal: 24, paddingBottom: 10 }}>
      <Mono c={color.vermilion}>PORTALS FROM {displayName(state?.title ?? "").title.toUpperCase()}</Mono>
      {portals.map((p) => (
        <View key={p.trackId} style={s.portal}>
          <Serif size={18} numberOfLines={1} style={{ flex: 1 }}>{displayName(p.title).title}</Serif>
          <Mono>{p.count} · {p.pair}</Mono>
        </View>
      ))}
    </View>
  ) : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.night }} edges={["top", "bottom"]}>
      <View style={{ paddingHorizontal: 24, paddingTop: 14 }}>
        <View style={s.head}>
          <Serif size={44 * k}>The crate</Serif>
          <Word label="Groups" size={17} onPress={() => router.push("/groups")} />
        </View>
        <Mono>{loading ? "LOADING…" : `${groups.length} SONGS · ${tracks.length} VERSIONS`}</Mono>
        <View style={s.search}>
          <Svg width={20} height={20} viewBox="0 0 20 20">
            <Circle cx={8.5} cy={8.5} r={6} fill="none" stroke={color.vermilion} strokeWidth={2} />
            <Path d="M13 13l5 5" stroke={color.vermilion} strokeWidth={2} strokeLinecap="round" />
          </Svg>
          <TextInput value={q} onChangeText={setQ} placeholder="Search songs" placeholderTextColor={color.paperDim} returnKeyType="search" autoCorrect={false} style={s.input} accessibilityLabel="Search songs" />
          {q ? <Word label="×" size={24} accessibilityLabel="Clear the search" style={{ width: 44, alignItems: "center" }} onPress={() => setQ("")} /> : null}
        </View>
        <View style={s.filters}>
          {FILTERS.map(([id, label]) => <Word key={id} label={label} size={16} on={filter === id} onPress={() => setFilter(id)} />)}
        </View>
      </View>

      <FlatList
        data={shown}
        keyExtractor={(g) => g.id}
        ListHeaderComponent={header}
        ListEmptyComponent={loading ? undefined : <Narrow style={{ paddingHorizontal: 24 }}>{q ? `Nothing in the crate for “${q}”.` : "Nothing here."}</Narrow>}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 12 }}
        initialNumToRender={10}
        windowSize={7}
        renderItem={({ item, index }) => (
          <Row group={item} index={index} open={open === item.id} onToggle={() => setOpen(open === item.id ? null : item.id)} />
        )}
      />
      <MiniRecord state={state} />
    </SafeAreaView>
  );
}

function Row({ group, index, open, onToggle }: { group: SongGroup; index: number; open: boolean; onToggle: () => void }) {
  const m = main(group);
  const n = group.versions.length;
  const analysed = group.versions.some((v) => v.trackId);
  const artist = artistLine(group.name || m.title, displayName(m.title).artist);
  const dx = Math.round(-46 + 34 * Math.sin(index * 0.82));
  const note = analysed
    ? [m.camelot, artist, n > 1 ? `${n} versions` : ""].filter(Boolean).join(" · ")
    : "Not read yet";
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => (n > 1 ? onToggle() : SaicsPlayer.playTrack(m.uri))}
        style={({ pressed }) => [{ height: ROW, opacity: pressed ? 0.65 : 1 }]}>
        <Svg width={112} height={112} viewBox="0 0 120 120" style={{ position: "absolute", left: dx, top: -13 }}>
          <Circle cx={60} cy={60} r={58} fill={color.vinyl} stroke={color.groove} />
          <Circle cx={60} cy={60} r={46} fill="none" stroke={color.groove} />
          <Circle cx={60} cy={60} r={36} fill="none" stroke={color.groove} />
          <Circle cx={60} cy={60} r={20} fill={analysed ? keyColor(m.camelot) : color.unread} />
          <Circle cx={60} cy={60} r={3} fill={color.night} />
        </Svg>
        <View style={{ position: "absolute", left: dx + 124, right: 16, top: 14 }}>
          <Serif size={21} numberOfLines={1}>{displayName(group.name || m.title).title}</Serif>
          <Mono c={analysed ? color.paperDim : color.vermilion} style={{ marginTop: 3 }}>{note}</Mono>
        </View>
      </Pressable>
      {open ? group.versions.map((v) => <Pressing key={v.uri} track={v} left={dx + 124} />) : null}
    </View>
  );
}

function Pressing({ track, left }: { track: Track; left: number }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => SaicsPlayer.playTrack(track.uri)} style={({ pressed }) => ({ minHeight: 48, justifyContent: "center", paddingLeft: left, paddingRight: 16, opacity: pressed ? 0.6 : 1 })}>
      <Serif size={17} numberOfLines={1}>{versionLabel(track.version)}</Serif>
      <Mono>{track.trackId ? `${Math.round(track.bpm)} BPM · ${track.camelot || "phone"}` : "Not read yet"}</Mono>
    </Pressable>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  search: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  input: { flex: 1, height: 48, paddingHorizontal: 0, color: color.paper, fontFamily: font.narrow, fontSize: 20 },
  filters: { flexDirection: "row", justifyContent: "space-between" },
  portal: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 34 },
});
