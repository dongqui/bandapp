import type { StyleProp, TextStyle } from "react-native";
import { AppText } from "./AppText";

export function MonoLabel({
  children,
  color,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <AppText variant="monoLabel" color={color} style={style}>
      {children}
    </AppText>
  );
}
