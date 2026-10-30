import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { color } from "../theme/tokens";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: color.bg },
          headerTintColor: color.text,
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: color.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "SAICS" }} />
        <Stack.Screen name="library" options={{ title: "Library" }} />
        <Stack.Screen name="buttons" options={{ title: "Button test" }} />
      </Stack>
    </>
  );
}
