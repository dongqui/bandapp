import { View } from "react-native";
import { useTheme } from "@/theme";
import { AppText } from "./AppText";

export function Avatar({
  label,
  size = 40,
  dashed = false,
}: {
  label: string;
  size?: number;
  dashed?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: dashed ? undefined : colors.surfaceRaised,
        borderWidth: dashed ? 1 : 0,
        borderStyle: dashed ? "dashed" : undefined,
        borderColor: colors.borderStronger,
      }}
    >
      <AppText variant="monoAvatar" color={dashed ? colors.textMuted : colors.textSecondary}>
        {label}
      </AppText>
    </View>
  );
}
