import { View } from "react-native";
import { useTheme } from "@/theme";

/** 월 사용량 막대 — 사용한 만큼(회색)과 남은 만큼(accent)을 가로로 나란히 */
export function UsageBar({ usedPct, leftPct }: { usedPct: number; leftPct: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.borderStrong, flexDirection: "row", overflow: "hidden" }}>
      <View style={{ width: `${usedPct}%`, backgroundColor: colors.borderHover }} />
      <View style={{ width: `${leftPct}%`, backgroundColor: colors.accent }} />
    </View>
  );
}
