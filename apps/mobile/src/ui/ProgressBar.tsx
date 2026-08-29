import { View } from "react-native";
import { useTheme } from "@/theme";

export function ProgressBar({ progress, width = 240 }: { progress: number; width?: number }) {
  const { colors } = useTheme();
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <View style={{ width, height: 4, borderRadius: 2, backgroundColor: colors.toastBg, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height: "100%", borderRadius: 2, backgroundColor: colors.accent }} />
    </View>
  );
}
