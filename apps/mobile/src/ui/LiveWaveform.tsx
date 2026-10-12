import { View } from "react-native";
import { barHeight } from "@/lib/peaks";
import { useTheme } from "@/theme";
import { fitLevels } from "./liveWaveformLevels";

/** 바 34개 × 200ms 틱 = 최근 6.8초 (2026-10-12 스펙 결정 1). */
export const LIVE_BARS = 34;

/**
 * 녹음 중 라이브 파형. 상태는 RecordingScreen이 들고 여기선 levels(0~1, 오래된 것 → 최근)를 그리기만 한다.
 * levels가 비어 있으면 모든 바가 최소 높이라 PREPARING·미터링 미지원에서 가짜 움직임이 없다.
 */
export function LiveWaveform({ levels, bars = LIVE_BARS, height = 72 }: { levels: number[]; bars?: number; height?: number }) {
  const { colors } = useTheme();
  const minPx = Math.round(height * 0.12);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, height }}>
      {fitLevels(levels, bars).map((level, i) => (
        <View
          key={i}
          style={{ width: 3, borderRadius: 1.5, backgroundColor: colors.textSecondary, height: barHeight(level, height, minPx) }}
        />
      ))}
    </View>
  );
}
