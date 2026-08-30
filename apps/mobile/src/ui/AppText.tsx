import { Text, type TextProps } from "react-native";
import { type as typeScale, type TypeVariant } from "@/theme";

interface Props extends TextProps {
  variant?: TypeVariant;
  color?: string;
}

export function AppText({ variant = "body", color, style, ...rest }: Props) {
  return <Text {...rest} style={[typeScale[variant], color ? { color } : null, style]} />;
}
