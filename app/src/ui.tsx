import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { color, radius, space, type } from "./theme/tokens";

export function Button({ label, onPress, kind = "plain", style, big }: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "plain" | "accent";
  style?: ViewStyle;
  big?: boolean;
}) {
  const bg = kind === "primary" ? color.amber : "transparent";
  const fg = kind === "primary" ? "#111" : kind === "accent" ? color.cyan : color.text;
  const border = kind === "primary" ? color.amber : kind === "accent" ? color.cyan : color.line;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.btn, { backgroundColor: bg, borderColor: border, opacity: pressed ? 0.7 : 1 },
        big && { minHeight: 72 }, style,
      ]}
    >
      <Text style={[type.body, { color: fg, fontWeight: "600", textAlign: "center" }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={[type.label, { color: color.textMuted, textTransform: "uppercase" }]}>{children}</Text>;
}

const s = StyleSheet.create({
  btn: {
    borderWidth: 1, borderRadius: radius.md, paddingVertical: space.md, paddingHorizontal: space.lg,
    minHeight: 48, justifyContent: "center",
  },
  card: {
    backgroundColor: color.surface, borderColor: color.line, borderWidth: 1, borderRadius: radius.lg,
    padding: space.lg, gap: space.md,
  },
});
