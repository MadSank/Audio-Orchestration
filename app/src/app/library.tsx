import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import SaicsPlayer, { type Track } from "../../modules/saics-player";
import { color, radius, space, type } from "../theme/tokens";

export default function Library() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  useEffect(() => {
    // The service keeps the last scan; only walk the folder if there is none yet.
    SaicsPlayer.getLibrary()
      .then((t) => (t.length ? t : SaicsPlayer.scanLibrary()))
      .then(setTracks)
      .catch(() => setTracks([]))
      .finally(() => setLoading(false));
  }, []);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? tracks.filter((t) => t.title.toLowerCase().includes(needle)) : tracks;
  }, [q, tracks]);

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder={loading ? "Loading library…" : `Search ${tracks.length} songs`}
        placeholderTextColor={color.textMuted}
        style={s.search}
      />
      <FlatList
        data={shown}
        keyExtractor={(t) => t.uri}
        contentContainerStyle={{ padding: space.lg, gap: space.sm }}
        renderItem={({ item }) => (
          <Pressable onPress={() => SaicsPlayer.playTrack(item.uri)} style={({ pressed }) => [s.row, pressed && { opacity: 0.6 }]}>
            <Text style={[type.body, { color: color.text }]} numberOfLines={1}>{item.title}</Text>
            <Text style={[type.mono, { color: item.version === "original" ? color.textMuted : color.cyan, fontFamily: "monospace" }]} numberOfLines={1}>
              {item.version} · {item.gainDb >= 0 ? "+" : ""}{item.gainDb.toFixed(1)} dB{item.group ? ` · ${item.group}` : ""}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  search: {
    margin: space.lg, marginBottom: 0, padding: space.md, borderRadius: radius.md, borderWidth: 1,
    borderColor: color.line, color: color.text, backgroundColor: color.surface,
  },
  row: {
    padding: space.md, borderRadius: radius.md, backgroundColor: color.surface, borderWidth: 1,
    borderColor: color.line, gap: 2,
  },
});
