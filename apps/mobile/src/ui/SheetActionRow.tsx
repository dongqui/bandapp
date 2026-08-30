import type { ReactNode } from "react";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

export function SheetActionRow({
  icon,
  title,
  subtitle,
  onPress,
  trailing,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  onPress: () => void;
  trailing?: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 14,
        paddingHorizontal: 12,
        borderRadius: radius.row,
      }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <AppText variant="rowTitle">{title}</AppText>
        {subtitle ? (
          <AppText variant="caption" style={{ marginTop: 2 }}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing ?? null}
    </PressableOpacity>
  );
}
