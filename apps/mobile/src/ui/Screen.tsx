import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/theme";

export function Screen({
  children,
  style,
  padTop = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padTop?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <View
      style={[
        { flex: 1, backgroundColor: colors.bg, paddingTop: padTop ? insets.top + 8 : 0 },
        style,
      ]}
    >
      {children}
    </View>
  );
}
