import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { AppState, FlatList, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";

import SaicsPlayer, { addListener, type ButtonEvent, type HelmetButton, type PlayerSettings } from "../../modules/saics-player";
import { Mono, Narrow, Serif, useK, Word } from "../obi";
import { usePlayerState } from "../usePlayer";
import { color } from "../theme/tokens";

const MAP: { button: HelmetButton; label: string; icon: (y: number) => string; acts: [string, string][] }[] = [
  { button: "PLAY_PAUSE", label: "Play or pause", icon: (y) => `M57 ${y - 11}l20 11-20 11z`, acts: [["×1", "Pause or resume"], ["×2", "Vinyl on or off"], ["×3", "Next station"]] },
  { button: "NEXT", label: "Next", icon: (y) => `M56 ${y - 11}l15 11-15 11zM72 ${y - 11}h4v22h-4z`, acts: [["×1", "Next portal"], ["×2", "A new song now"]] },
  { button: "PREVIOUS", label: "Previous", icon: (y) => `M76 ${y - 11}l-15 11 15 11zM56 ${y - 11}h4v22h-4z`, acts: [["×1", "Restart, or the song before"], ["×2", "Forever on or off"]] },
];
const SPACE = 62;

function describe(e: ButtonEvent): string {
  if (e.type === "press") {
    const gap = e.sinceLastMs != null ? `+${e.sinceLastMs} ms` : "first";
    return `press  ${e.keyName ?? e.button}  #${e.count}  (${gap})`;
  }
  return `ACTION ${e.button} ×${e.count}`;
}

/** Three buttons with lines running out to what they do; settings and the button test below. */
export default function Helmet() {
  const router = useRouter();
  const state = usePlayerState();
  const k = useK();
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

  const map = useMemo(() => {
    let d = "";
    const rows: { n: string; text: string; y: number }[] = [];
    const buttons: { y: number; button: HelmetButton; label: string; icon: string }[] = [];
    let cursor = 20;
    for (const g of MAP) {
      const h = g.acts.length * SPACE;
      const y0 = cursor + h / 2;
      buttons.push({ y: y0, button: g.button, label: g.label, icon: g.icon(y0) });
      g.acts.forEach(([n, text], i) => {
        const y = y0 + (i - (g.acts.length - 1) / 2) * SPACE;
        d += `M110 ${y0} C126 ${y0} 126 ${y} 142 ${y}`;
        rows.push({ n, text, y });
      });
      cursor += h + 24;
    }
    return { d, rows, buttons, height: cursor };
  }, []);

  const head = (
    <View>
      <View style={{ paddingHorizontal: 24, paddingTop: 14 }}>
        <Serif size={44 * k}>Under{"\n"}your thumb</Serif>
        <Mono style={{ marginTop: 6 }}>THREE BUTTONS ON THE CARDO · TAP ONE TO TEST</Mono>
      </View>

      <View style={{ height: map.height }}>
        <Svg width="100%" height={map.height} style={StyleSheet.absoluteFill}>
          <Path d={map.d} fill="none" stroke="#6E6556" strokeWidth={1.5} />
          {map.buttons.map((b) => (
            <Circle key={b.button} cx={66} cy={b.y} r={44} fill={color.vinyl} stroke={color.grooveLit} />
          ))}
          {map.buttons.map((b) => <Circle key={b.button} cx={66} cy={b.y} r={20} fill={color.vermilion} />)}
          {map.buttons.map((b) => <Path key={b.button} d={b.icon} fill={color.night} />)}
        </Svg>
        {map.buttons.map((b) => (
          <Word key={b.button} label="" accessibilityLabel={`Simulate ${b.label}`} onPress={() => SaicsPlayer.simulatePress(b.button)}
            style={{ position: "absolute", left: 22, top: b.y - 44, width: 88, height: 88 }} />
        ))}
        {map.rows.map((r) => (
          <View key={`${r.y}`} style={[s.act, { top: r.y - 13 }]}>
            <Mono c={color.vermilion}>{r.n}</Mono>
            <Serif size={18} numberOfLines={1} style={{ flex: 1 }}>{r.text}</Serif>
          </View>
        ))}
      </View>

      <View style={s.settings}>
        <Mono>MUSIC FOLDER</Mono>
        <Narrow numberOfLines={2} c={color.paper}>{folder ? decodeURIComponent(folder.split("/tree/")[1] ?? folder) : "Not chosen yet"}</Narrow>
        <Mono>{scanning ? "scanning…" : `${count ?? state?.libraryCount ?? 0} files`}</Mono>
        {scanError ? <Mono c={color.vermilion} numberOfLines={3}>Scan failed: {scanError}</Mono> : null}
        <View style={s.row}>
          <Word label={folder ? "Change folder" : "Choose folder"} on={!folder} onPress={pick} />
          {folder ? <Word label="Rescan" onPress={scan} /> : null}
          <Word label="Set aside" onPress={() => router.push("/aside")} />
        </View>
        {batteryOk ? <Mono>BACKGROUND PLAYBACK ALLOWED</Mono> : <Word label="Allow background playback" on onPress={() => SaicsPlayer.requestIgnoreBatteryOptimizations()} />}

        <Mono style={{ marginTop: 14 }}>PRESS TIMING</Mono>
        <Stepper label="Double press" value={settings?.multiWindowMs} step={50} onChange={(v) => update({ multiWindowMs: v })} />
        <Stepper label="Triple press" value={settings?.tripleWindowMs} step={100} onChange={(v) => update({ tripleWindowMs: v })} />

        <Mono style={{ marginTop: 14 }}>WHAT YOU HEAR</Mono>
        <Word label="Spoken confirmations" on={!!settings?.tts} onPress={() => update({ tts: !settings?.tts })} />
        <Word label="Beeps" on={!!settings?.earcons} onPress={() => update({ earcons: !settings?.earcons })} />
        <Word label="Announce the next song" on={!!settings?.announceTitles} onPress={() => update({ announceTitles: !settings?.announceTitles })} />
        <Word label="Speak each press while testing" on={speakEvents} onPress={() => setSpeakEvents(!speakEvents)} />

        <Mono style={{ marginTop: 14 }}>RECEIVED ({log.length})</Mono>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.night }} edges={["top", "bottom"]}>
      <FlatList
        data={log}
        keyExtractor={(e, i) => `${e.at}-${i}`}
        ListHeaderComponent={head}
        contentContainerStyle={{ paddingBottom: 12 }}
        renderItem={({ item }) => (
          <Mono c={item.type === "action" ? color.vermilion : color.paperDim} style={{ paddingHorizontal: 24, paddingVertical: 1 }}>{new Date(item.at).toLocaleTimeString()}  {describe(item)}</Mono>
        )}
      />
    </SafeAreaView>
  );
}

function Stepper({ label, value, step, onChange }: { label: string; value?: number; step: number; onChange: (v: number) => void }) {
  return (
    <View style={s.row}>
      <Narrow c={color.paper} style={{ flex: 1 }}>{label}</Narrow>
      <Word label="−" size={24} accessibilityLabel={`${label} shorter`} style={{ width: 48, alignItems: "center" }} onPress={() => value != null && onChange(value - step)} />
      <Mono size={15} c={color.paper} style={{ width: 76, textAlign: "center" }}>{value ?? "…"} ms</Mono>
      <Word label="+" size={24} accessibilityLabel={`${label} longer`} style={{ width: 48, alignItems: "center" }} onPress={() => value != null && onChange(value + step)} />
    </View>
  );
}

const s = StyleSheet.create({
  act: { position: "absolute", left: 148, right: 16, flexDirection: "row", alignItems: "center", gap: 8 },
  settings: { paddingHorizontal: 24, gap: 4 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
});
