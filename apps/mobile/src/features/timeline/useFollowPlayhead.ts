import { useEffect } from "react";
import { useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { followViewport } from "@/lib/timeline/follow";
import type { TimelineViewportState } from "./useTimelineViewport";

/**
 * 재생 시작 → ON, 사용자 팬/핀치/오버뷰 → OFF(각 제스처가 끈다) (2026-09-11 스펙 결정 10).
 * 2026-09-20 디자인 개정에서 "⟲ PLAYHEAD" 필이 빠졌다 — 다시 켜는 길은 재생 시작, 파형 탭 seek, take 선택이다.
 * follow 자체는 vp.follow shared value에 산다 — 제스처 worklet과 이 훅이 같은 값을 본다.
 */
export function useFollowPlayhead(vp: TimelineViewportState, playheadMs: SharedValue<number>, durationMs: number, playing: boolean): void {
  useEffect(() => {
    if (playing) vp.follow.value = true;
  }, [playing, vp.follow]);

  useAnimatedReaction(
    () => playheadMs.value,
    (ms) => {
      if (!vp.follow.value) return;
      const next = followViewport({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, ms, durationMs);
      if (next) vp.startMs.value = next.startMs;
    },
    [durationMs],
  );
}
