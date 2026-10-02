import { useCallback } from "react";
import { View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { viewportEndMs } from "@/lib/timeline/viewport";
import { AppText } from "@/ui";
import type { PeaksSource } from "./useSessionPeaks";
import type { TimelineViewportState } from "./useTimelineViewport";
import { useUiMirror } from "./useUiMirror";

/** __DEV__ 전용. 스크린샷만 보고도 상태를 알 수 있게 (초안 30절). useUiMirror가 80ms로 묶어 React에 넘긴다 */
export function TimelineDebugOverlay({
  vp,
  playheadMs,
  level,
  source,
  selectedTakeId,
}: {
  vp: TimelineViewportState;
  playheadMs: SharedValue<number>;
  level: SharedValue<number>;
  source: PeaksSource;
  selectedTakeId: string | null;
}) {
  const read = useCallback(() => {
    "worklet";
    const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
    return {
      startMs: v.startMs,
      endMs: viewportEndMs(v),
      msPerPx: v.msPerPx,
      level: level.value,
      playheadMs: Math.round(playheadMs.value),
      follow: vp.follow.value,
      gesture: vp.activeGesture.value ?? "-",
    };
  }, [vp, level, playheadMs]);
  const snap = useUiMirror([vp.startMs, vp.msPerPx, vp.widthPx, vp.follow, vp.activeGesture, level, playheadMs], read);
  if (!snap) return null;
  const lines = [
    `view ${Math.round(snap.startMs)}..${Math.round(snap.endMs)} ms  ${snap.msPerPx.toFixed(2)} ms/px  LOD ${snap.level}`,
    `playhead ${snap.playheadMs} ms  follow ${snap.follow}  gesture ${snap.gesture}`,
    `peaks ${source}  take ${selectedTakeId ?? "-"}`,
  ];
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 60, left: 8, right: 8, backgroundColor: "rgba(0,0,0,0.6)", padding: 6, borderRadius: 4 }}>
      {lines.map((l) => (
        <AppText key={l} variant="monoMeta" style={{ fontSize: 10, lineHeight: 13 }}>
          {l}
        </AppText>
      ))}
    </View>
  );
}
