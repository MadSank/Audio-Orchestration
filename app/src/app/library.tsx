import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import SaicsPlayer, { type PortalGroup, type Track } from "../../modules/saics-player";
import { ChevronDown, ChevronRight, Disc, Search } from "../icons";
import { displayName } from "../names";
import { Badge, BottomNav, Display, Label, MiniPlayer, Mono } from "../ui";
import { type SongGroup, useLibrary, usePlayerState } from "../usePlayer";
import { color, font, radius, space } from "../theme/tokens";

type Filter = "all" | "key" | "tempo" | "pending";
const FILTERS: [Filter, string][] = [["all", "All"], ["key", "By key"], ["tempo", "By tempo"], ["pending", "Not analysed"]];
const SWATCH = [color.cyan, color.amber, color.lilac, color.pink];

/** Stable art colour per song. */
const swatch = (id: string) => SWATCH[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % SWATCH.length];
const main = (g: SongGroup) => g.versions.find((v) => v.version === "original") ?? g.versions[0];

export default function Library() {
  const state = usePlayerState();
  const { tracks, groups, loading } = useLibrary();
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
    const needle = q.trim().toLowerCase();
    let out = groups;
    if (needle) {
      out = out.filter((g) => g.name.toLowerCase().includes(needle) || g.versions.some((v) =>
        v.title.toLowerCase().includes(needle) || v.camelot.toLowerCase() === needle || String(Math.round(v.bpm)) === needle));
    }
    if (filter === "pending") out = out.filter((g) => g.versions.every((v) => !v.trackId));
    if (filter === "key") out = [...out].sort((a, b) => main(a).camelot.localeCompare(main(b).camelot, undefined, { numeric: true }));
    if (filter === "tempo") out = [...out].sort((a, b) => main(a).bpm - main(b).bpm);
    return out;
  }, [groups, q, filter]);

  const header = (
    <View style={{ gap: 4, paddingBottom: 4 }}>
      {portals.length > 0 && !q ? (
        <>
          <Label c={color.cyan} style={{ marginBottom: 4 }}>PORTALS FROM {displayName(state?.title ?? "").title.toUpperCase()}</Label>
          {portals.map((p) => (
            <View key={p.trackId} style={s.row}>
              <Disc label={swatch(p.trackId)} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={s.rowTitle}>{displayName(p.title).title}</Text>
                <Text numberOfLines={1} style={s.rowSub}>{displayName(p.title).artist || `${Math.round(p.bpm)} BPM · ${p.camelot}`}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Mono size={13} c={color.cyan} bold>{p.count} {p.count === 1 ? "PORTAL" : "PORTALS"}</Mono>
                <Mono>{p.pair}</Mono>
              </View>
            </View>
          ))}
        </>
      ) : null}
      <Label style={{ marginTop: portals.length > 0 && !q ? 14 : 0, marginBottom: 4 }}>SONGS · A–Z · TAP FOR VERSIONS</Label>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={["top", "bottom"]}>
      <View style={s.head}>
        <Display size={26}>LIBRARY</Display>
        <Mono>{loading ? "LOADING…" : `${groups.length} SONGS · ${tracks.length} VERSIONS`}</Mono>
      </View>

      <View style={{ paddingHorizontal: space.xl, gap: space.md }}>
        <View style={s.search}>
          <Search />
          <TextInput value={q} onChangeText={setQ} placeholder="Song, artist, key (8A) or BPM" placeholderTextColor={color.textFaint} style={s.input} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} style={{ flexGrow: 0 }}>
          {FILTERS.map(([id, label]) => {
            const on = filter === id;
            return (
              <Pressable key={id} onPress={() => setFilter(id)} style={[s.chip, on ? s.chipOn : null]} accessibilityState={{ selected: on }}>
                <Text style={{ fontFamily: on ? font.extrabold : font.semibold, fontSize: 13, color: on ? color.bg : color.text }}>{label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <FlatList
        data={shown}
        keyExtractor={(g) => g.id}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.sm }}
        initialNumToRender={14}
        renderItem={({ item }) => <GroupRow group={item} open={open === item.id} onToggle={() => setOpen(open === item.id ? null : item.id)} />}
      />

      <MiniPlayer state={state} />
      <BottomNav />
    </SafeAreaView>
  );
}

function GroupRow({ group, open, onToggle }: { group: SongGroup; open: boolean; onToggle: () => void }) {
  const m = main(group);
  const analysed = group.versions.some((v) => v.trackId);
  const n = group.versions.length;
  const name = displayName(group.name || m.title);
  const artist = displayName(m.title).artist;
  return (
    <View>
      <Pressable onPress={onToggle} style={s.row} accessibilityState={{ expanded: open }}>
        <Disc label={swatch(group.id)} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={s.rowTitle}>{name.title}</Text>
          {artist ? <Text numberOfLines={1} style={s.rowSub}>{artist}</Text> : null}
        </View>
        {analysed ? (
          <View style={{ alignItems: "flex-end", gap: 3 }}>
            <Badge text={`${n} ${n === 1 ? "VERSION" : "VERSIONS"}`} />
            <Mono>{Math.round(m.bpm)} · {m.camelot}</Mono>
          </View>
        ) : (
          <View style={s.pending}><Mono size={10} c={color.amber} bold style={{ letterSpacing: 0.8 }}>NOT ANALYSED</Mono></View>
        )}
        {open ? <ChevronDown size={16} c={color.textFaint} /> : <ChevronRight size={16} c={color.textFaint} />}
      </Pressable>
      {open ? group.versions.map((v) => <VersionRow key={v.uri} track={v} />) : null}
    </View>
  );
}

function VersionRow({ track }: { track: Track }) {
  return (
    <Pressable onPress={() => SaicsPlayer.playTrack(track.uri)} style={({ pressed }) => [s.version, pressed && { opacity: 0.6 }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: font.bold, fontSize: 14, color: color.text }}>{track.version.replace(/\+/g, " + ")}</Text>
        <Text numberOfLines={1} style={{ fontFamily: font.regular, fontSize: 12, color: color.textMuted }}>{displayName(track.title).title}</Text>
      </View>
      <Mono>{track.trackId ? `${Math.round(track.bpm)} · ${track.camelot}` : ""}</Mono>
    </Pressable>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: 10 },
  search: { flexDirection: "row", alignItems: "center", gap: 10, height: 48, paddingHorizontal: 14, borderRadius: radius.row, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  input: { flex: 1, height: 44, color: color.text, fontFamily: font.regular, fontSize: 15 },
  chip: { height: 36, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, borderColor: color.border, justifyContent: "center" },
  chipOn: { backgroundColor: color.text, borderColor: color.text },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 58 },
  rowTitle: { fontFamily: font.bold, fontSize: 15, color: color.text },
  rowSub: { fontFamily: font.regular, fontSize: 13, color: color.textMuted },
  pending: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1, borderColor: color.amberEdge },
  version: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48, marginLeft: 56, borderTopWidth: 1, borderColor: color.divider },
});
