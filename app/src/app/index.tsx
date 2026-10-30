import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, ScrollView, StyleSheet, Text, View } from "react-native";

import SaicsPlayer, { STATIONS } from "../../modules/saics-player";
import { Button, Card, Label } from "../ui";
import { usePlayerState } from "../usePlayer";
import { color, space, type } from "../theme/tokens";

export default function Home() {
  const state = usePlayerState();
  const [folder, setFolder] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [batteryOk, setBatteryOk] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    setFolder(SaicsPlayer.getFolder());
    setBatteryOk(SaicsPlayer.isIgnoringBatteryOptimizations());
    // Re-check when returning from the system battery dialog or settings.
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") setBatteryOk(SaicsPlayer.isIgnoringBatteryOptimizations());
    });
    return () => sub.remove();
  }, []);

  async function scan() {
    setScanning(true);
    setScanError(null);
    try {
      const tracks = await SaicsPlayer.scanLibrary();
      setCount(tracks.length);
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

  const libraryCount = count ?? state?.libraryCount ?? 0;
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Card>
        <Label>Now playing</Label>
        <Text style={[type.title, { color: state?.isPlaying ? color.amber : color.text }]} numberOfLines={2}>
          {state?.title ?? "Nothing playing"}
        </Text>
        <Text style={[type.mono, { color: color.textMuted, fontFamily: "monospace" }]}>
          {state ? `${state.station} · ${state.version ?? ""}` : ""}
          {state?.forever ? " · FOREVER" : ""}
          {state?.vinyl ? " · VINYL" : ""}
        </Text>
        <View style={s.row}>
          <Button label="⏮" onPress={() => SaicsPlayer.previous()} style={s.flex} />
          <Button label={state?.isPlaying ? "Pause" : "Play"} kind="primary" onPress={() => SaicsPlayer.togglePlay()} style={s.flex2} />
          <Button label="⏭" onPress={() => SaicsPlayer.next()} style={s.flex} />
        </View>
        <View style={s.row}>
          <Button label={state?.forever ? "Forever: on" : "Forever: off"} kind="accent" onPress={() => SaicsPlayer.toggleForever()} style={s.flex} />
          <Button label={state?.vinyl ? "Vinyl: on" : "Vinyl: off"} onPress={() => SaicsPlayer.toggleVinyl()} style={s.flex} />
        </View>
      </Card>

      <Label>Stations</Label>
      {STATIONS.map((name, i) => (
        <Button key={name} label={name} big kind={state?.stationIndex === i && state?.isPlaying ? "primary" : "plain"}
          onPress={() => SaicsPlayer.startStation(i)} />
      ))}

      <Card>
        <Label>Music folder</Label>
        <Text style={[type.body, { color: color.text }]} numberOfLines={2}>
          {folder ? decodeURIComponent(folder.split("/tree/")[1] ?? folder) : "Not chosen yet"}
        </Text>
        <Text style={[type.mono, { color: color.textMuted, fontFamily: "monospace" }]}>
          {scanning ? "scanning…" : `${libraryCount} songs`}
        </Text>
        {scanError ? <Text style={[type.mono, { color: color.danger, fontFamily: "monospace" }]}>Scan failed: {scanError}</Text> : null}
        <View style={s.row}>
          <Button label={folder ? "Change folder" : "Choose folder"} kind={folder ? "plain" : "primary"} onPress={pick} style={s.flex} />
          {folder ? <Button label="Rescan" onPress={scan} style={s.flex} /> : null}
        </View>
        <Link href="/library" asChild>
          <Button label="Browse library" onPress={() => {}} />
        </Link>
      </Card>

      <Card>
        <Label>Helmet</Label>
        <Text style={[type.body, { color: color.textMuted }]}>
          Start playback here once per ride; the Cardo buttons then control SAICS with the screen off.
        </Text>
        <Link href="/buttons" asChild>
          <Button label="Button test & settings" kind="accent" onPress={() => {}} />
        </Link>
        {!batteryOk ? (
          <Button label="Allow background playback (battery)" kind="primary"
            onPress={() => SaicsPlayer.requestIgnoreBatteryOptimizations()} />
        ) : (
          <Text style={[type.mono, { color: color.textMuted, fontFamily: "monospace" }]}>Battery optimisation: off for SAICS ✓</Text>
        )}
      </Card>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 },
  row: { flexDirection: "row", gap: space.sm },
  flex: { flex: 1 },
  flex2: { flex: 2 },
});
