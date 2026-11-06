import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import SaicsPlayer from "../../modules/saics-player";
import { color } from "../theme/tokens";

export default function RootLayout() {
  // Notifications: the media card, the status bar chip and the island. Media: new songs in Download.
  useEffect(() => {
    if (Platform.OS === "android" && Platform.Version >= 33) {
      PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
      ])
        .then(() => SaicsPlayer.refreshAnalysis())
        .catch(() => {});
    }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.night }, animation: "fade" }}>
        <Stack.Screen name="now-playing" options={{ animation: "slide_from_bottom" }} />
        <Stack.Screen name="versions" options={{ animation: "fade" }} />
        <Stack.Screen name="ride" options={{ animation: "fade", contentStyle: { backgroundColor: color.ride } }} />
      </Stack>
    </SafeAreaProvider>
  );
}
