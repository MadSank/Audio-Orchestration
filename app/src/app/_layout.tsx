import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { color } from "../theme/tokens";

export default function RootLayout() {
  // The media notification, the status bar chip and the island all need this permission.
  useEffect(() => {
    if (Platform.OS === "android" && Platform.Version >= 33) {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
    }
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: "fade" }}>
        <Stack.Screen name="now-playing" options={{ animation: "slide_from_bottom" }} />
        <Stack.Screen name="versions" options={{ presentation: "transparentModal", animation: "slide_from_bottom", contentStyle: { backgroundColor: "transparent" } }} />
      </Stack>
    </SafeAreaProvider>
  );
}
