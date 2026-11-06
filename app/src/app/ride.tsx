import { useRouter } from "expo-router";
import { Animated, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";

import SaicsPlayer from "../../modules/saics-player";
import { displayName } from "../names";
import { Narrow, ObiTitle, Serif, useK, useSpin, Word } from "../obi";
import { usePlayerState } from "../usePlayer";
import { color, OBI_WIDTH } from "../theme/tokens";

const GROOVES = [122, 134, 146, 158, 170, 182, 194];

/** Stopped at the lights: pure black, and the whole record is the pause button. */
export default function Ride() {
  const router = useRouter();
  const state = usePlayerState();
  const k = useK();
  const insets = useSafeAreaInsets();
  const name = displayName(state?.title ?? "");
  const spin = useSpin(!!state?.isPlaying);
  const rotate = spin.interpolate({ inputRange: [0, 360], outputRange: ["0deg", "360deg"] });
  const portal = state?.nextPortal;
  const D = 420 * k;

  return (
    <View style={{ flex: 1, backgroundColor: color.ride, overflow: "hidden" }}>
      <Pressable accessibilityRole="button" accessibilityLabel={state?.isPlaying ? "Pause" : "Play"} onPress={() => SaicsPlayer.togglePlay()}
        style={{ position: "absolute", left: -60 * k, top: insets.top + 270 * k, width: D, height: D }}>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Svg width={D} height={D} viewBox="0 0 420 420">
            <Circle cx={210} cy={210} r={209} fill="#111111" />
            {GROOVES.map((r) => <Circle key={r} cx={210} cy={210} r={r} fill="none" stroke="#2A2A2A" />)}
          </Svg>
        </Animated.View>
        <Svg width={D} height={D} viewBox="0 0 420 420" style={{ position: "absolute" }} pointerEvents="none">
          <Circle cx={210} cy={210} r={104} fill={color.paper} />
          <Path d={state?.isPlaying ? "M180 164h24v92h-24zM218 164h24v92h-24z" : "M184 160l70 50-70 50z"} fill={color.ride} />
        </Svg>
      </Pressable>

      <View style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: OBI_WIDTH * k, backgroundColor: color.vermilion, alignItems: "center", paddingTop: insets.top + 26 * k }}>
        <ObiTitle title={name.title || "SAICS"} height={560 * k} ink={color.ride} />
      </View>

      <View style={{ position: "absolute", left: 24 * k, right: (OBI_WIDTH + 24) * k, top: insets.top + 24 * k }}>
        <Serif size={38 * k} numberOfLines={3} adjustsFontSizeToFit>{name.title || "Nothing playing"}</Serif>
        <Narrow size={22} bold c={color.paper} style={{ marginTop: 10 }} numberOfLines={2}>
          {portal ? `Portal in ${portal.inBars} ${portal.inBars === 1 ? "bar" : "bars"}` : state?.forever ? "Forever" : state?.station ?? ""}
        </Narrow>
      </View>

      <View style={{ position: "absolute", left: 24 * k, right: (OBI_WIDTH + 24) * k, bottom: insets.bottom + 16, flexDirection: "row", justifyContent: "space-between" }}>
        <Word label="Next" size={28} onPress={() => SaicsPlayer.simulatePress("NEXT")} style={{ minHeight: 64 }} />
        <Word label="Exit" size={20} onPress={() => router.back()} style={{ minHeight: 64 }} />
      </View>
    </View>
  );
}
