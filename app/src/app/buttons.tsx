import { useEffect, useState } from "react";
import { FlatList, StyleSheet, Switch, Text, View } from "react-native";

import SaicsPlayer, { addListener, type ButtonEvent, type PlayerSettings } from "../../modules/saics-player";
import { Button, Card, Label } from "../ui";
import { color, space, type } from "../theme/tokens";

const MAPPING: [string, string][] = [
  ["Play/Pause ×1", "Pause / resume"],
  ["Play/Pause ×2", "Toggle Vinyl"],
  ["Play/Pause ×3", "Next station"],
  ["Next ×1", "Next song (Forever: next version)"],
  ["Next ×2", "Hard cut to next song"],
  ["Previous ×1", "Restart / previous song (<5 s)"],
  ["Previous ×2", "Toggle Forever"],
];

function describe(e: ButtonEvent): string {
  if (e.type === "press") {
    const gap = e.sinceLastMs != null ? `+${e.sinceLastMs} ms` : "first";
    return `press  ${e.keyName ?? e.button}  #${e.count}  (${gap})`;
  }
  return `ACTION ${e.button} ×${e.count}`;
}

export default function ButtonTest() {
  const [log, setLog] = useState<ButtonEvent[]>([]);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [speakEvents, setSpeakEvents] = useState(true);

  useEffect(() => {
    SaicsPlayer.getButtonLog().then(setLog).catch(() => {});
    SaicsPlayer.getSettings().then(setSettings).catch(() => {});
    const sub = addListener("onButton", (e) => {
      setLog((l) => [e, ...l].slice(0, 100));
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const e = log[0];
    if (speakEvents && e && e.type === "action") {
      const name = e.button === "PLAY_PAUSE" ? "play pause" : e.button.toLowerCase();
      SaicsPlayer.speak(`${name} ${e.count === 1 ? "single" : e.count === 2 ? "double" : "triple"}`);
    }
  }, [log, speakEvents]);

  async function update(v: Partial<PlayerSettings>) {
    setSettings(await SaicsPlayer.setSettings(v));
  }

  return (
    <FlatList
      style={{ backgroundColor: color.bg }}
      contentContainerStyle={{ padding: space.lg, gap: space.sm, paddingBottom: space.xxl * 2 }}
      data={log}
      keyExtractor={(e, i) => `${e.at}-${i}`}
      ListHeaderComponent={
        <View style={{ gap: space.md, marginBottom: space.md }}>
          <Card>
            <Label>How to test</Label>
            <Text style={[type.body, { color: color.textMuted }]}>
              Start playback, then press the Cardo buttons. Every key the phone receives is listed below with
              the time since the previous press, and each recognised action is spoken.
            </Text>
            {MAPPING.map(([k, v]) => (
              <View key={k} style={s.mapRow}>
                <Text style={[type.mono, s.mono, { color: color.amber, width: 120 }]}>{k}</Text>
                <Text style={[type.body, { color: color.text, flex: 1 }]}>{v}</Text>
              </View>
            ))}
          </Card>

          <Card>
            <Label>Multi-press window</Label>
            <View style={s.mapRow}>
              <Button label="−" onPress={() => settings && update({ multiWindowMs: settings.multiWindowMs - 50 })} />
              <Text style={[type.title, s.mono, { color: color.text, flex: 1, textAlign: "center" }]}>
                {settings?.multiWindowMs ?? "…"} ms
              </Text>
              <Button label="+" onPress={() => settings && update({ multiWindowMs: settings.multiWindowMs + 50 })} />
            </View>
            <Label>Triple-press window (play/pause ×3)</Label>
            <View style={s.mapRow}>
              <Button label="−" onPress={() => settings && update({ tripleWindowMs: settings.tripleWindowMs - 100 })} />
              <Text style={[type.title, s.mono, { color: color.text, flex: 1, textAlign: "center" }]}>
                {settings?.tripleWindowMs ?? "…"} ms
              </Text>
              <Button label="+" onPress={() => settings && update({ tripleWindowMs: settings.tripleWindowMs + 100 })} />
            </View>
            <Toggle label="Spoken confirmations (TTS)" value={!!settings?.tts} onChange={(v) => update({ tts: v })} />
            <Toggle label="Earcons" value={!!settings?.earcons} onChange={(v) => update({ earcons: v })} />
            <Toggle label="Announce next song title" value={!!settings?.announceTitles} onChange={(v) => update({ announceTitles: v })} />
            <Toggle label="Speak each action on this screen" value={speakEvents} onChange={setSpeakEvents} />
          </Card>

          <Card>
            <Label>Simulate (no helmet)</Label>
            <View style={s.mapRow}>
              <Button label="⏯" onPress={() => SaicsPlayer.simulatePress("PLAY_PAUSE")} style={{ flex: 1 }} />
              <Button label="⏮" onPress={() => SaicsPlayer.simulatePress("PREVIOUS")} style={{ flex: 1 }} />
              <Button label="⏭" onPress={() => SaicsPlayer.simulatePress("NEXT")} style={{ flex: 1 }} />
            </View>
          </Card>
          <Label>Received ({log.length})</Label>
        </View>
      }
      renderItem={({ item }) => (
        <Text style={[type.mono, s.mono, { color: item.type === "action" ? color.cyan : color.text }]}>
          {new Date(item.at).toLocaleTimeString()}  {describe(item)}
        </Text>
      )}
    />
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.mapRow}>
      <Text style={[type.body, { color: color.text, flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: color.amber, false: color.line }} />
    </View>
  );
}

const s = StyleSheet.create({
  mapRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  mono: { fontFamily: "monospace" },
});
