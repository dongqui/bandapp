import { View, type LayoutChangeEvent, type GestureResponderEvent } from "react-native";
import { useMemo, useRef } from "react";
import { barHeight, resamplePeaks } from "@/lib/peaks";
import { useTheme } from "@/theme";

export function PlayerWaveform({
  peaks,
  durationSec,
  positionSec,
  markers = [],
  onSeek,
  height = 88,
}: {
  /** null이면 평평한 플레이스홀더 */
  peaks: number[] | null;
  durationSec: number;
  positionSec: number;
  markers?: number[];
  onSeek: (sec: number) => void;
  height?: number;
}) {
  const { colors } = useTheme();
  const width = useRef(1);
  const bars = 64;
  const units = useMemo(() => resamplePeaks(peaks, bars), [peaks, bars]);
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
        {units.map((u, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              borderRadius: 1,
              backgroundColor: i / bars <= frac ? colors.accent : colors.borderStronger,
              height: barHeight(u, height, 3),
            }}
          />
        ))}
      </View>
    </View>
  );
}
