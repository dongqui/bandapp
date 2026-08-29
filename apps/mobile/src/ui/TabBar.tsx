import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { font, useTheme } from "@/theme";
import { AppText } from "./AppText";
import { Fab } from "./Fab";
import { PressableOpacity } from "./PressableOpacity";

export function TabBar({
  active,
  onPressSessions,
  onPressBand,
  onPressFab,
}: {
  active: "sessions" | "band";
  onPressSessions: () => void;
  onPressBand: () => void;
  onPressFab: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const label = (text: string, isActive: boolean, onPress: () => void) => (
    <PressableOpacity onPress={onPress} style={{ padding: 12 }}>
      <AppText
        style={{
          fontFamily: font.mono,
          fontSize: 11,
          letterSpacing: 1.5,
          color: isActive ? colors.text : colors.textFaint,
        }}
      >
        {text}
      </AppText>
    </PressableOpacity>
  );
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: 12,
        paddingBottom: insets.bottom + 16,
        flexDirection: "row",
        alignItems: "center",
        borderTopWidth: 1,
        borderTopColor: colors.surfaceRaised,
        backgroundColor: colors.tabBarBg,
      }}
    >
      <View style={{ flex: 1, alignItems: "center" }}>{label("SESSIONS", active === "sessions", onPressSessions)}</View>
      <View style={{ width: 84, height: 54, alignItems: "center" }}>
        <View
          style={{
            position: "absolute",
            top: -42,
            width: 84,
            height: 84,
            borderRadius: 42,
            backgroundColor: colors.bg,
            borderWidth: 1,
            borderColor: colors.surfaceRaised,
          }}
        />
        <View style={{ position: "absolute", top: -30 }}>
          <Fab onPress={onPressFab} />
        </View>
      </View>
      <View style={{ flex: 1, alignItems: "center" }}>{label("BAND", active === "band", onPressBand)}</View>
    </View>
  );
}
