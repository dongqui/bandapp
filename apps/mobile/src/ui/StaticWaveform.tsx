import { View } from "react-native";
import { seededUnit } from "@/lib/seed";
import { useTheme } from "@/theme";

export function StaticWaveform({
  seed,
  bars = 36,
  height = 26,
  color,
}: {
  seed: number;
  bars?: number;
  height?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
      {Array.from({ length: bars }, (_, i) => (
        <View
          key={i}
          style={{
            width: 2,
            borderRadius: 1,
            backgroundColor: color ?? colors.borderHover,
            height: Math.max(2, Math.round((0.12 + 0.88 * seededUnit(seed * 97 + i * 13)) * height)),
          }}
        />
      ))}
    </View>
  );
}
