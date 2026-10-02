import type { StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/theme";
import { AppText, PressableOpacity } from "@/ui";

/** take 메뉴를 여는 "···" 원형 버튼 (2026-10-02 디자인 — 타임라인 내비 오른쪽 34px, Take Feedback 헤더 36px) */
export function TakeMoreButton({ size = 34, onPress, style }: { size?: number; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      hitSlop={6}
      style={[{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: colors.borderStrong, alignItems: "center", justifyContent: "center" }, style]}
    >
      <AppText style={{ fontSize: size > 34 ? 14 : 13, lineHeight: 16, letterSpacing: 0.8, color: colors.textMuted }}>···</AppText>
    </PressableOpacity>
  );
}
