import { useEffect, useState } from "react";
import { AppState, FlatList, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import SaicsPlayer, { addListener, type ButtonEvent, type PlayerSettings } from "../../modules/saics-player";
import { Next, Pause, Prev } from "../icons";
import { Body, BottomNav, Display, IconBtn, Label, MiniPlayer, Mono, Pill } from "../ui";
import { usePlayerState } from "../usePlayer";
import { color, font, radius, space } from "../theme/tokens";

const MAPPING: [string, string][] = [
  ["Play/Pause ×1", "Pause / resume"],
  ["Play/Pause ×2", "Toggle Vinyl"],
  ["Play/Pause ×3", "Next station"],
  ["Next ×1", "Take the next portal (next phrase)"],
  ["Next ×2", "A new song now (Forever stays on)"],
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

/** Helmet & settings: music folder, background playback, button mapping and the Button test. */
export default function ButtonTest() {
  const state = usePlayerState();
  const [log, setLog] = useState<ButtonEvent[]>([]);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [speakEvents, setSpeakEvents] = useState(false);
  const [folder, setFolder] = useState<string | null>(SaicsPlayer.getFolder());
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [batteryOk, setBatteryOk] = useState(SaicsPlayer.isIgnoringBatteryOptimizations());

  useEffect(() => {
    SaicsPlayer.getButtonLog().then(setLog).catch(() => {});
    SaicsPlayer.getSettings().then(setSettings).catch(() => {});
    const sub = addListener("onButton", (e) => setLog((l) => [e, ...l].slice(0, 100)));
    const app = AppState.addEventListener("change", (a) => { // back from the system battery dialog
      if (a === "active") setBatteryOk(SaicsPlayer.isIgnoringBatteryOptimizations());
    });
    return () => { sub.remove(); app.remove(); };
  }, []);

  useEffect(() => {
    const e = log[0];
    if (speakEvents && e && e.type === "action") {
      const name = e.button === "PLAY_PAUSE" ? "play pause" : e.button.toLowerCase();
      SaicsPlayer.speak(`${name} ${e.count === 1 ? "single" : e.count === 2 ? "double" : "triple"}`);
    }
  }, [log, speakEvents]);

  async function scan() {
    setScanning(true);
    setScanError(null);
    try {
      setCount((await SaicsPlayer.scanLibrary()).length);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }
  async function pick() {
    const uri = await SaicsPlayer.pickFolder();
    if (uri) {
      setFolder(uri);
      await scan();
    }
  }
  async function update(v: Partial<PlayerSettings>) {
    setSettings(await SaicsPlayer.setSettings(v));
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={["top", "bottom"]}>
      <FlatList
        contentContainerStyle={{ padding: space.xl, gap: space.xs, paddingBottom: space.md }}
        data={log}
        keyExtractor={(e, i) => `${e.at}-${i}`}
        ListHeaderComponent={
          <View style={{ gap: space.md, marginBottom: space.md }}>
            <Display size={26}>HELMET</Display>

            <View style={s.card}>
              <Label>MUSIC FOLDER</Label>
              <Text numberOfLines={2} style={s.value}>{folder ? decodeURIComponent(folder.split("/tree/")[1] ?? folder) : "Not chosen yet"}</Text>
              <Mono>{scanning ? "scanning…" : `${count ?? state?.libraryCount ?? 0} files`}</Mono>
              {scanError ? <Mono c={color.danger} numberOfLines={3}>Scan failed: {scanError}</Mono> : null}
              <View style={s.row}>
                <Pill kind={folder ? "outline" : "primary"} label={folder ? "Change folder" : "Choose folder"} onPress={pick} style={{ flex: 1 }} />
                {folder ? <Pill label="Rescan" onPress={scan} style={{ flex: 1 }} /> : null}
              </View>
              {batteryOk ? <Mono>Background playback: allowed ✓</Mono> : (
                <Pill kind="primary" label="Allow background playback" onPress={() => SaicsPlayer.requestIgnoreBatteryOptimizations()} />
              )}
            </View>

            <View style={s.card}>
              <Label>CARDO BUTTONS</Label>
              {MAPPING.map(([k, v]) => (
                <View key={k} style={s.row}>
                  <Mono c={color.amber} style={{ width: 118 }}>{k}</Mono>
                  <Body style={{ flex: 1, color: color.text }}>{v}</Body>
                </View>
              ))}
            </View>

            <View style={s.card}>
              <Label>MULTI-PRESS WINDOW</Label>
              <Stepper value={settings?.multiWindowMs} step={50} onChange={(v) => update({ multiWindowMs: v })} />
              <Label>TRIPLE-PRESS WINDOW</Label>
              <Stepper value={settings?.tripleWindowMs} step={100} onChange={(v) => update({ tripleWindowMs: v })} />
              <Toggle label="Spoken confirmations" value={!!settings?.tts} onChange={(v) => update({ tts: v })} />
              <Toggle label="Earcons" value={!!settings?.earcons} onChange={(v) => update({ earcons: v })} />
              <Toggle label="Announce the next song" value={!!settings?.announceTitles} onChange={(v) => update({ announceTitles: v })} />
              <Toggle label="Speak each action while testing" value={speakEvents} onChange={setSpeakEvents} />
            </View>

            <View style={s.card}>
              <Label>BUTTON TEST · SIMULATE WITHOUT THE HELMET</Label>
              <View style={[s.row, { justifyContent: "space-around" }]}>
                <IconBtn size={56} border={color.border} onPress={() => SaicsPlayer.simulatePress("PREVIOUS")} accessibilityLabel="Simulate previous"><Prev size={24} /></IconBtn>
                <IconBtn size={56} border={color.border} onPress={() => SaicsPlayer.simulatePress("PLAY_PAUSE")} accessibilityLabel="Simulate play pause"><Pause size={24} /></IconBtn>
                <IconBtn size={56} border={color.border} onPress={() => SaicsPlayer.simulatePress("NEXT")} accessibilityLabel="Simulate next"><Next size={24} /></IconBtn>
              </View>
            </View>
            <Label>RECEIVED ({log.length})</Label>
          </View>
        }
        renderItem={({ item }) => (
          <Mono c={item.type === "action" ? color.cyan : color.text}>{new Date(item.at).toLocaleTimeString()}  {describe(item)}</Mono>
        )}
      />
      <MiniPlayer state={state} />
      <BottomNav />
    </SafeAreaView>
  );
}

function Stepper({ value, step, onChange }: { value?: number; step: number; onChange: (v: number) => void }) {
  return (
    <View style={s.row}>
      <Pill label="−" onPress={() => value != null && onChange(value - step)} style={{ width: 64 }} />
      <Text style={[s.value, { flex: 1, textAlign: "center", fontFamily: font.monoBold }]}>{value ?? "…"} ms</Text>
      <Pill label="+" onPress={() => value != null && onChange(value + step)} style={{ width: 64 }} />
    </View>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.row}>
      <Body style={{ flex: 1, color: color.text, fontSize: 15 }}>{label}</Body>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: color.amber, false: color.border }} thumbColor={value ? color.amberInk : color.textMuted} />
    </View>
  );
}

const s = StyleSheet.create({
  card: { padding: space.lg, gap: space.md, borderRadius: radius.tile, backgroundColor: color.surface, borderWidth: 1, borderColor: color.border },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  value: { fontFamily: font.semibold, fontSize: 15, color: color.text },
});
