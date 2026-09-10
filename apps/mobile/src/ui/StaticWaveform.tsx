import { useMemo } from "react";
import { View } from "react-native";
import { barHeight, resamplePeaks } from "@/lib/peaks";
import { useTheme } from "@/theme";

/** take 목록 행의 정적 파형. peaks가 null이면 평평한 플레이스홀더 (2026-09-10 스펙 결정 6). */
export function StaticWaveform({
  peaks,
  bars = 36,
  height = 26,
  color,
}: {
  peaks: number[] | null;
  bars?: number;
  height?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  const units = useMemo(() => resamplePeaks(peaks, bars), [peaks, bars]);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height }}>
      {units.map((u, i) => (
        <View
          key={i}
          style={{
            width: 2,
            borderRadius: 1,
            backgroundColor: color ?? colors.borderHover,
            height: barHeight(u, height, 2),
          }}
        />
      ))}
    </View>
  );
}
