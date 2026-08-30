import { Pressable, type PressableProps } from "react-native";

interface Props extends PressableProps {
  activeOpacity?: number;
}

export function PressableOpacity({ activeOpacity = 0.6, style, ...rest }: Props) {
  return (
    <Pressable
      {...rest}
      style={(state) => [
        typeof style === "function" ? style(state) : style,
        state.pressed ? { opacity: activeOpacity } : null,
      ]}
    />
  );
}
