import { useState } from "react";
import { View } from "react-native";
import { useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { viewportEndMs } from "@/lib/timeline/viewport";
import { AppText } from "@/ui";
import type { PeaksSource } from "./useSessionPeaks";
import type { TimelineViewportState } from "./useTimelineViewport";

interface Snapshot {
  startMs: number;
  endMs: number;
  msPerPx: number;
  level: number;
  playheadMs: number;
  follow: boolean;
  gesture: string;
}

/** __DEV__ 전용. 스크린샷만 보고도 상태를 알 수 있게 (초안 30절). 200ms에 한 번만 React로 넘긴다 */
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
  const [snap, setSnap] = useState<Snapshot | null>(null);
  useAnimatedReaction(
    () => Math.floor(Date.now() / 200),
    (tick, prev) => {
      if (tick === prev) return;
      const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
      scheduleOnRN(setSnap, {
        startMs: v.startMs,
        endMs: viewportEndMs(v),
        msPerPx: v.msPerPx,
        level: level.value,
        playheadMs: playheadMs.value,
        follow: vp.follow.value,
        gesture: vp.activeGesture.value ?? "-",
      });
    },
  );
  if (!snap) return null;
  const lines = [
    `view ${Math.round(snap.startMs)}..${Math.round(snap.endMs)} ms  ${snap.msPerPx.toFixed(2)} ms/px  LOD ${snap.level}`,
    `playhead ${Math.round(snap.playheadMs)} ms  follow ${snap.follow}  gesture ${snap.gesture}`,
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
