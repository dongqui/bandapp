import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

export function Chip({
  label,
  onPress,
  size = "sm",
  mono = false,
  trailing,
  style,
}: {
  label: string;
  onPress?: () => void;
  size?: "sm" | "lg";
  mono?: boolean;
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const lg = size === "lg";
  return (
    <PressableOpacity
      onPress={onPress}
      disabled={!onPress}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          alignSelf: "flex-start",
          borderWidth: 1,
          borderColor: colors.borderStrong,
          borderRadius: lg ? radius.chipLg : radius.chipSm,
          paddingVertical: lg ? 7 : 9,
          paddingHorizontal: lg ? 12 : 14,
        },
        style,
      ]}
    >
      <AppText
        variant={mono ? "monoLabel" : "caption"}
        color={colors.textSecondary}
        style={mono ? { letterSpacing: 1.8 } : { fontSize: 13 }}
      >
        {label}
      </AppText>
      {trailing}
    </PressableOpacity>
  );
}
