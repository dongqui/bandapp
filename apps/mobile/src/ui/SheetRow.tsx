import type { ReactNode } from "react";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

/** 디자인의 시트 행: 좌측 제목(+부제), 우측 값. danger는 빨간 제목. */
export function SheetRow({
  title,
  subtitle,
  trailing,
  danger = false,
  onPress,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  danger?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 14,
        paddingHorizontal: 12,
        borderRadius: radius.row,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontSize: 15, color: danger ? colors.danger : colors.text }}>{title}</AppText>
        {subtitle ? <AppText variant="caption">{subtitle}</AppText> : null}
      </View>
      {trailing ?? null}
    </PressableOpacity>
  );
}
