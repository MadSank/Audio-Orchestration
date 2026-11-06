import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import SaicsPlayer, { type Track } from "../../modules/saics-player";
import { displayName, versionLabel } from "../names";
import { Mono, Narrow, Serif, useK, Word } from "../obi";
import { type SongGroup, useLibrary } from "../usePlayer";
import { color, font } from "../theme/tokens";

/**
 * Song groups review: every group expands to its versions, with Merge and Split and a per-version
 * "not loopable" switch. Changes apply at once and are written to .saics/groups_overrides.csv and
 * forever_overrides.csv (hard rule 3).
 */
export default function Groups() {
  const router = useRouter();
  const k = useK();
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
    if (!ok) Alert.alert("Couldn't save", "SAICS needs write access to the music folder. Tap Change folder on the Helmet screen and pick it again.");
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
    <SafeAreaView style={{ flex: 1, backgroundColor: color.night }} edges={["top", "bottom"]}>
      <View style={{ paddingHorizontal: 24, paddingTop: 14 }}>
        <View style={s.head}>
          <Serif size={44 * k}>Groups</Serif>
          <Word label={merging ? "Cancel" : "Done"} size={18} on onPress={() => (merging ? setMerging(null) : router.back())} />
        </View>
        <Narrow size={15}>
          {merging ? `Pick the song that “${displayName(merging.name).title}” belongs to.` : `Versions of one song live together. ${groups.length} songs, ${tracks.length} versions; no audio is touched.`}
        </Narrow>
        {!canWrite ? <Mono c={color.vermilion} numberOfLines={2} style={{ marginTop: 4 }}>Read-only folder: tap Change folder on the Helmet screen to save changes.</Mono> : null}
        <TextInput value={q} onChangeText={setQ} placeholder="Find a song" placeholderTextColor={color.paperDim} style={s.input} accessibilityLabel="Find a song" />
      </View>
      <FlatList
        data={shown}
        keyExtractor={(g) => g.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 20 }}
        initialNumToRender={14}
        renderItem={({ item }) => (
          <Group group={item} open={open === item.id} merging={!!merging}
            onPress={() => (merging ? merge(item) : setOpen(open === item.id ? null : item.id))}
            onMerge={() => { setOpen(null); setQ(""); setMerging(item); }}
            onSplit={(t) => SaicsPlayer.splitTrack(t.uri).then(saved)}
            onLoopable={(t, v) => SaicsPlayer.setNotLoopable(t.uri, v).then(saved)} />
        )}
      />
    </SafeAreaView>
  );
}

function Group({ group, open, merging, onPress, onMerge, onSplit, onLoopable }: {
  group: SongGroup; open: boolean; merging: boolean; onPress: () => void; onMerge: () => void;
  onSplit: (t: Track) => void; onLoopable: (t: Track, notLoopable: boolean) => void;
}) {
  const n = group.versions.length;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onPress} style={({ pressed }) => [s.row, pressed && { opacity: 0.6 }]}>
        <Serif size={19} numberOfLines={1} style={{ flex: 1 }} c={open ? color.vermilion : color.paper}>{displayName(group.name).title}</Serif>
        <Mono>{n}</Mono>
      </Pressable>
      {open ? (
        <View style={{ paddingLeft: 16, paddingBottom: 10 }}>
          {group.versions.map((t) => (
            <View key={t.uri} style={{ paddingVertical: 4 }}>
              <Serif size={17} numberOfLines={1}>{versionLabel(t.version)}</Serif>
              <Mono numberOfLines={1}>{t.file || t.title}</Mono>
              <View style={s.row}>
                <Word label="Don't loop" size={16} on={t.notLoopable} onPress={() => onLoopable(t, !t.notLoopable)} />
                {n > 1 ? <Word label="Split off" size={16} onPress={() => onSplit(t)} /> : null}
              </View>
            </View>
          ))}
          <Word label="Merge into another song" size={16} onPress={onMerge} />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input: { height: 44, paddingHorizontal: 0, color: color.paper, fontFamily: font.narrow, fontSize: 17 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 48 },
});
