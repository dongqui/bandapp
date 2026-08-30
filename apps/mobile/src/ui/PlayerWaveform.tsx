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
  // locationX is relative to the touch target, so children must not become the
  // target (pointerEvents="none" below) for this math to hold during a drag.
  const seekAt = (e: GestureResponderEvent) => {
    const f = Math.max(0, Math.min(1, e.nativeEvent.locationX / width.current));
    onSeek(f * durationSec);
  };
  return (
    <View
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={seekAt}
      onResponderMove={seekAt}
      onResponderRelease={seekAt}
      onResponderTerminationRequest={() => false}
      style={{ width: "100%", height: height + 12, justifyContent: "flex-end" }}
    >
      {markers.map((sec, i) => (
        <View
          key={`m${i}`}
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: `${durationSec ? (sec / durationSec) * 100 : 0}%`,
            width: 6,
            height: 6,
            borderRadius: 3,
            marginLeft: -3,
            backgroundColor: colors.accent,
          }}
        />
      ))}
      <View pointerEvents="none" style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
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
