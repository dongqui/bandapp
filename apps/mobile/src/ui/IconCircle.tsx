import type { ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "@/theme";

export function IconCircle({ children, size = 44 }: { children: ReactNode; size?: number }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1,
        borderColor: colors.borderStronger,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}
