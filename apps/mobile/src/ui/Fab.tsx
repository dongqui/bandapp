import { useTheme } from "@/theme";
import { AppText } from "./AppText";
import { PressableOpacity } from "./PressableOpacity";

export function Fab({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        width: 60,
        height: 60,
        borderRadius: 30,
        backgroundColor: colors.accent,
        alignItems: "center",
        justifyContent: "center",
        shadowColor: "#000",
        shadowOpacity: 0.45,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
      }}
    >
      <AppText style={{ color: colors.bg, fontSize: 28, fontWeight: "300", lineHeight: 32 }}>+</AppText>
    </PressableOpacity>
  );
}
