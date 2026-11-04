import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import SaicsPlayer from "../../modules/saics-player";
import { Close } from "../icons";
import { displayName } from "../names";
import { Body, Display, IconBtn, Mono } from "../ui";
import { usePlayerState } from "../usePlayer";
import { color, font, radius, space } from "../theme/tokens";

/** Versions sheet (design 03, revision 2): the song group's versions, switching on the next bar. */
export default function Versions() {
  const router = useRouter();
  const state = usePlayerState();
  const current = state?.versions?.[(state?.versionIndex ?? 1) - 1]?.uri;

  return (
    <View style={{ flex: 1, backgroundColor: "rgba(5,5,6,0.72)" }}>
      <Pressable style={{ height: 118 }} onPress={() => router.back()} accessibilityLabel="Close versions" />
      <SafeAreaView edges={["bottom"]} style={s.sheet}>
        <View style={s.handle} />
        <View style={s.head}>
          <View style={{ flex: 1 }}>
            <Display size={22}>VERSIONS</Display>
            <Body style={{ fontSize: 13 }}>Switches on the next bar, at the same point in the song</Body>
          </View>
          <IconBtn bg={color.surfaceRaised} onPress={() => router.back()} accessibilityLabel="Close"><Close size={18} /></IconBtn>
        </View>

        <ScrollView contentContainerStyle={{ gap: 6 }} style={{ flex: 1 }}>
          {state?.versions?.map((v) => {
            const on = v.uri === current;
            return (
              <Pressable key={v.uri} onPress={() => SaicsPlayer.pickVersion(v.uri)} style={[s.row, on && s.rowOn]} accessibilityState={{ selected: on }}>
                <View style={[s.dot, on && s.dotOn]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontFamily: on ? font.extrabold : font.bold, fontSize: 16, color: color.text }}>{v.version.replace(/\+/g, " + ")}</Text>
                  <Body numberOfLines={1} style={{ fontSize: 12, color: on ? "#D9C9AE" : color.textMuted }}>{displayName(v.title).title}</Body>
                </View>
                {on ? <Mono size={11} c={color.amber} bold>ON</Mono> : null}
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={s.footer}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: font.bold, fontSize: 15, color: color.text }}>Vinyl</Text>
            <Body style={{ fontSize: 12 }}>Warm band-pass, crackle, wow and flutter</Body>
          </View>
          <Switch value={!!state?.vinyl} onValueChange={() => SaicsPlayer.toggleVinyl()}
            trackColor={{ true: color.amber, false: color.border }} thumbColor={state?.vinyl ? color.amberInk : color.textMuted} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: color.surface, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, borderTopWidth: 1, borderColor: color.border, paddingHorizontal: space.lg, paddingTop: 10, gap: space.md },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: color.section, alignSelf: "center" },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 6, paddingHorizontal: 14, borderRadius: radius.row, borderWidth: 1, borderColor: color.border },
  rowOn: { backgroundColor: color.amberTint, borderColor: color.amber, borderWidth: 1.5 },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: color.textFaint },
  dotOn: { backgroundColor: color.amber, borderColor: color.amber },
  footer: { flexDirection: "row", alignItems: "center", gap: space.md, padding: 14, borderRadius: radius.row, backgroundColor: color.surfaceRaised, marginBottom: space.md },
});
