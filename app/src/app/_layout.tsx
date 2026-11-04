import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { color } from "../theme/tokens";

export default function RootLayout() {
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
