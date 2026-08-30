import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";

export function StatusDot({
  color,
  size = 6,
  pulse = true,
}: {
  color: string;
  size?: number;
  pulse?: boolean;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, opacity]);
  return (
    <Animated.View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity }}
    />
  );
}
