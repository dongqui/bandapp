import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { seededUnit } from "@/lib/seed";
import { useTheme } from "@/theme";

function Bar({ index, height }: { index: number; height: number }) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const duration = (0.4 + seededUnit(index * 3.1) * 0.5) * 1000;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 0.2, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    const delay = setTimeout(() => loop.start(), seededUnit(index * 5.7) * 500);
    return () => {
      clearTimeout(delay);
      loop.stop();
    };
  }, [index, scale]);
  const barHeight = Math.round(14 + seededUnit(index * 7.3 + 2) * 56);
  return (
    <Animated.View
      style={{
        width: 3,
        borderRadius: 1.5,
        backgroundColor: colors.textSecondary,
        height: (barHeight / 72) * height,
        transform: [{ scaleY: scale }],
      }}
    />
  );
}

export function LiveWaveform({ bars = 34, height = 72 }: { bars?: number; height?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height }}>
      {Array.from({ length: bars }, (_, i) => (
        <Bar key={i} index={i} height={height} />
      ))}
    </View>
  );
}
