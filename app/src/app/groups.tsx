import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import SaicsPlayer, { type Track } from "../../modules/saics-player";
import { Back, ChevronDown, ChevronRight, Search } from "../icons";
import { displayName } from "../names";
import { Badge, Body, Display, IconBtn, Label, Mono, Pill } from "../ui";
import { type SongGroup, useLibrary } from "../usePlayer";
import { color, font, radius, space } from "../theme/tokens";

/**
 * Song groups review (design revision 2, "not drawn"): every group expands to its versions,
 * with Merge and Split and a per-version "not loopable" toggle. Changes apply at once and are
 * written to .saics/groups_overrides.csv and forever_overrides.csv (hard rule 3).
 */
export default function Groups() {
  const router = useRouter();
  const { groups, tracks, reload } = useLibrary();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [merging, setMerging] = useState<SongGroup | null>(null);
  const canWrite = SaicsPlayer.canWriteOverrides();

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = merging ? groups.filter((g) => g.id !== merging.id) : groups;
    const hits = needle ? list.filter((g) => g.name.toLowerCase().includes(needle) || g.versions.some((v) => v.title.toLowerCase().includes(needle))) : list;
    return [...hits].sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name));
  }, [groups, q, merging]);

  function saved(ok: boolean) {
    if (!ok) Alert.alert("Couldn't save", "SAICS needs write access to the music folder. Choose the folder again in Helmet & settings.");
    reload();
  }
  function merge(into: SongGroup) {
    const from = merging;
    if (!from) return;
    Alert.alert("Merge these songs?", `“${displayName(from.name).title}” (${from.versions.length}) joins “${displayName(into.name).title}”.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Merge", onPress: () => { setMerging(null); setOpen(into.id); SaicsPlayer.mergeGroups(from.id, into.id).then(saved); } },
    ]);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={["top", "bottom"]}>
      <View style={s.head}>
        <IconBtn onPress={() => router.back()} accessibilityLabel="Back"><Back size={20} /></IconBtn>
        <Display size={22}>SONG GROUPS</Display>
      </View>
      <Body style={s.intro}>
        {merging ? `Pick the song that “${displayName(merging.name).title}” belongs to.` : `Versions of the same song live together. ${groups.length} songs, ${tracks.length} versions; changes stay in .saics/ and no audio is touched.`}
      </Body>
      {!canWrite ? <Mono c={color.danger} style={s.warn} numberOfLines={2}>Read-only folder: choose it again in Helmet & settings to save changes.</Mono> : null}

      <View style={s.search}>
        <Search />
        <TextInput value={q} onChangeText={setQ} placeholder="Find a song" placeholderTextColor={color.textFaint} style={s.input} />
      </View>
      {merging ? <Pill label="Cancel merge" onPress={() => setMerging(null)} style={{ marginHorizontal: space.xl, marginBottom: space.sm }} /> : null}

      <FlatList
        data={shown}
        keyExtractor={(g) => g.id}
        contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl }}
        initialNumToRender={14}
        renderItem={({ item }) => (
          <GroupCard group={item} open={open === item.id} merging={!!merging}
            onPress={() => (merging ? merge(item) : setOpen(open === item.id ? null : item.id))}
            onMerge={() => { setOpen(null); setQ(""); setMerging(item); }}
            onSplit={(t) => SaicsPlayer.splitTrack(t.uri).then(saved)}
            onLoopable={(t, v) => SaicsPlayer.setNotLoopable(t.uri, v).then(saved)} />
        )}
      />
    </SafeAreaView>
  );
}

function GroupCard({ group, open, merging, onPress, onMerge, onSplit, onLoopable }: {
  group: SongGroup; open: boolean; merging: boolean; onPress: () => void; onMerge: () => void;
  onSplit: (t: Track) => void; onLoopable: (t: Track, notLoopable: boolean) => void;
}) {
  const n = group.versions.length;
  return (
    <View style={{ borderTopWidth: 1, borderColor: color.divider }}>
      <Pressable onPress={onPress} style={s.row} accessibilityState={{ expanded: open }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={s.title}>{displayName(group.name).title}</Text>
        </View>
        <Badge text={`${n} ${n === 1 ? "VERSION" : "VERSIONS"}`} />
        {merging ? null : open ? <ChevronDown size={16} c={color.textFaint} /> : <ChevronRight size={16} c={color.textFaint} />}
      </Pressable>
      {open ? (
        <View style={{ paddingBottom: space.md, gap: space.xs }}>
          {group.versions.map((t) => (
            <View key={t.uri} style={s.version}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontFamily: font.bold, fontSize: 14, color: color.text }}>{t.version.replace(/\+/g, " + ")}</Text>
                  <Mono numberOfLines={1}>{t.file || t.title}</Mono>
                </View>
                {n > 1 ? <Pill h={44} label="Split" onPress={() => onSplit(t)} /> : null}
              </View>
              <View style={s.toggle}>
                <Label>NOT LOOPABLE</Label>
                <Switch value={t.notLoopable} onValueChange={(v) => onLoopable(t, v)} trackColor={{ true: color.amber, false: color.border }} thumbColor={t.notLoopable ? color.amberInk : color.textMuted} />
              </View>
            </View>
          ))}
          <Pill label="Merge into another song" onPress={onMerge} />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
  intro: { marginHorizontal: space.xl, marginTop: space.xs, marginBottom: space.md, lineHeight: 20 },
  warn: { marginHorizontal: space.xl, marginBottom: space.md },
  search: { flexDirection: "row", alignItems: "center", gap: 10, height: 48, marginHorizontal: space.xl, marginBottom: space.md, paddingHorizontal: 14, borderRadius: radius.row, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  input: { flex: 1, height: 44, color: color.text, fontFamily: font.regular, fontSize: 15 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 58 },
  title: { fontFamily: font.bold, fontSize: 15, color: color.text },
  version: { padding: space.md, gap: space.xs, borderRadius: radius.row, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
