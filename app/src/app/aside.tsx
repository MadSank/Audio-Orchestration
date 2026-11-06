import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle } from "react-native-svg";

import SaicsPlayer from "../../modules/saics-player";
import { displayName } from "../names";
import { Mono, Narrow, Serif, useK, Word } from "../obi";
import { color } from "../theme/tokens";

const WHY: Record<string, string> = {
  long: "Too long to loop",
  short: "Too short to be a song",
  duplicate: "A better copy is on the shelf",
  unreadable: "This file won't decode",
  sfx: "A sound effect, not a song",
  speech: "Speech, not a song",
};

/** Files the laptop moved out of the library. It lists them; `saics triage --undo` puts them back. */
export default function Aside() {
  const router = useRouter();
  const k = useK();
  const [rows, setRows] = useState<{ title: string; why: string }[] | null>(null);

  useEffect(() => {
    SaicsPlayer.getSetAside().then((list) => setRows(list.map((m) => {
      const parts = m.dest.replace(/\\/g, "/").split("/");
      const cls = parts[parts.lastIndexOf("_set_aside") + 1] ?? "";
      return { title: displayName(parts[parts.length - 1].replace(/\.[^.]+$/, "")).title, why: WHY[cls] ?? "Set aside" };
    }))).catch(() => setRows([]));
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.night }} edges={["top", "bottom"]}>
      <View style={{ paddingHorizontal: 24, paddingTop: 14, paddingBottom: 10 }}>
        <Serif size={44 * k}>Off the{"\n"}shelf</Serif>
        <Mono style={{ marginTop: 6 }}>NOTHING HERE IS DELETED · RESTORED FROM THE LAPTOP</Mono>
      </View>
      <FlatList
        data={rows ?? []}
        keyExtractor={(r, i) => `${r.title}-${i}`}
        contentContainerStyle={{ paddingVertical: 8 }}
        ListEmptyComponent={rows ? <Narrow style={{ paddingHorizontal: 24 }}>Nothing has been set aside.</Narrow> : undefined}
        renderItem={({ item }) => (
          <View style={{ height: 104, overflow: "hidden" }}>
            <Svg width={150} height={150} viewBox="0 0 150 150" style={{ position: "absolute", right: -62 * k, top: -22 }}>
              <Circle cx={75} cy={75} r={73} fill={color.vinyl} stroke={color.groove} />
              <Circle cx={75} cy={75} r={56} fill="none" stroke={color.groove} />
              <Circle cx={75} cy={75} r={42} fill="none" stroke={color.groove} />
              <Circle cx={75} cy={75} r={24} fill={color.unread} />
              <Circle cx={75} cy={75} r={4} fill={color.night} />
            </Svg>
            <View style={{ position: "absolute", left: 24, right: 100, top: 10 }}>
              <Serif size={20} numberOfLines={2}>{item.title}</Serif>
              <Narrow size={15} numberOfLines={1} style={{ marginTop: 3 }}>{item.why}</Narrow>
            </View>
          </View>
        )}
      />
      <View style={{ paddingHorizontal: 24 }}>
        <Word label="Done" on onPress={() => router.back()} />
      </View>
    </SafeAreaView>
  );
}
