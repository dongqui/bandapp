import { View, type LayoutChangeEvent, type GestureResponderEvent } from "react-native";
import { useRef } from "react";
import { seededUnit } from "@/lib/seed";
import { useTheme } from "@/theme";

export function PlayerWaveform({
  seed,
  durationSec,
  positionSec,
  markers = [],
  onSeek,
  height = 88,
}: {
  seed: number;
  durationSec: number;
  positionSec: number;
  markers?: number[];
  onSeek: (sec: number) => void;
  height?: number;
}) {
  const { colors } = useTheme();
  const width = useRef(1);
  const bars = 64;
  const frac = durationSec ? positionSec / durationSec : 0;
  const onLayout = (e: LayoutChangeEvent) => {
    width.current = e.nativeEvent.layout.width;
  };
  const onPress = (e: GestureResponderEvent) => {
    const f = Math.max(0, Math.min(1, e.nativeEvent.locationX / width.current));
    onSeek(f * durationSec);
  };
  return (
    <View
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onResponderRelease={onPress}
      style={{ width: "100%", height: height + 12, justifyContent: "flex-end" }}
    >
      {markers.map((sec, i) => (
        <View
          key={`m${i}`}
          style={{
            position: "absolute",
            top: 0,
            left: `${(sec / durationSec) * 100}%`,
            width: 6,
            height: 6,
            borderRadius: 3,
            marginLeft: -3,
            backgroundColor: colors.accent,
          }}
        />
      ))}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
        {Array.from({ length: bars }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              borderRadius: 1,
              backgroundColor: i / bars <= frac ? colors.accent : colors.borderStronger,
              height: Math.max(3, Math.round((0.12 + 0.88 * seededUnit(seed * 97 + i * 13)) * height)),
            }}
          />
        ))}
      </View>
    </View>
  );
}
