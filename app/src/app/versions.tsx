import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Defs, Path, Text as SvgText, TextPath } from "react-native-svg";

import SaicsPlayer from "../../modules/saics-player";
import { displayName, versionLabel } from "../names";
import { Mono, Narrow, Serif, useK, Word } from "../obi";
import { usePlayerState } from "../usePlayer";
import { color, font } from "../theme/tokens";

const PER_RECORD = 6;
const BAND = 34;
const OUTER = 262;
const BANDS = [["#23312A", "#E4F0E6"], ["#272139", "#E9E3F7"], ["#3A281D", "#F6E6D8"], ["#25303F", "#E2EAF4"], ["#2C261E", color.paper]];

/** One song, every groove: each ring of the record is a version. Tap a ring to switch. */
export default function Versions() {
  const router = useRouter();
  const state = usePlayerState();
  const k = useK();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState(0);
  const versions = useMemo(() => state?.versions ?? [], [state?.versions]);
  const current = versions[(state?.versionIndex ?? 1) - 1]?.uri;
  const pages = Math.max(1, Math.ceil(versions.length / PER_RECORD));
  const shown = versions.slice(page * PER_RECORD, (page + 1) * PER_RECORD);
  const size = 470 * k;

  // A touch anywhere on the record picks the ring under it.
  function touch(x: number, y: number) {
    const r = Math.hypot(x - size / 2, y - size / 2) * (560 / size);
    const i = Math.floor((OUTER + BAND / 2 - r) / BAND);
    if (i >= 0 && i < shown.length) SaicsPlayer.pickVersion(shown[i].uri);
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.night, overflow: "hidden" }}>
      <View style={{ position: "absolute", left: 24, right: 24, top: insets.top + 16 }}>
        <Mono>{displayName(state?.title ?? "").title.toUpperCase()}</Mono>
        <Serif size={40 * k} style={{ marginTop: 4 }}>One song,{"\n"}every groove</Serif>
      </View>

      <Pressable accessibilityRole="adjustable" accessibilityLabel={`Versions: ${shown.map((v) => versionLabel(v.version)).join(", ")}`}
        onPress={(e) => touch(e.nativeEvent.locationX, e.nativeEvent.locationY)}
        style={{ position: "absolute", left: -40 * k, top: insets.top + 150 * k, width: size, height: size }}>
        <Svg width={size} height={size} viewBox="0 0 560 560" pointerEvents="none">
          <Circle cx={280} cy={280} r={278} fill={color.vinyl} />
          <Defs>
            {shown.map((_, i) => {
              const tr = OUTER - i * BAND - 6;
              return <Path key={i} id={`ring${i}`} d={`M${280 - tr} 280 A${tr} ${tr} 0 0 1 ${280 + tr} 280`} />;
            })}
          </Defs>
          {shown.map((v, i) => {
            const on = v.uri === current;
            const [band, ink] = on ? [color.paper, color.night] : BANDS[i % BANDS.length];
            return (
              <Circle key={v.uri} cx={280} cy={280} r={OUTER - i * BAND} fill="none" stroke={band} strokeWidth={BAND - 4} />
            );
          })}
          {shown.map((v, i) => {
            const on = v.uri === current;
            const ink = on ? color.night : BANDS[i % BANDS.length][1];
            const label = `${versionLabel(v.version).toUpperCase()}${on ? " · PLAYING" : ""}`;
            return (
              <SvgText key={v.uri} fontFamily={font.narrowBold} fontSize={17} letterSpacing={1.5} fill={ink}>
                <TextPath href={`#ring${i}`} startOffset="50%" textAnchor="middle">{label}</TextPath>
              </SvgText>
            );
          })}
          <Circle cx={280} cy={280} r={62} fill={color.vermilion} />
          <Circle cx={280} cy={280} r={6} fill={color.night} />
        </Svg>
      </Pressable>

      <View style={{ position: "absolute", left: 24, right: 24, bottom: insets.bottom + 12 }}>
        <Narrow>Tap a ring. It changes on the next bar, and the music never stops.</Narrow>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Word label="Vinyl" on={state?.vinyl} onPress={() => SaicsPlayer.toggleVinyl()} />
          {pages > 1 ? <Word label={`More (${page + 1}/${pages})`} onPress={() => setPage((page + 1) % pages)} /> : null}
          <Word label="Done" on onPress={() => router.back()} />
        </View>
      </View>
    </View>
  );
}
