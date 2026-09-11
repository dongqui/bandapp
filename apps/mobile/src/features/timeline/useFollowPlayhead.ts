import { useCallback, useEffect, useState } from "react";
import { runOnUI, useAnimatedReaction, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { followViewport } from "@/lib/timeline/follow";
import type { TimelineViewportState } from "./useTimelineViewport";

export interface FollowPlayhead {
  /** React 미러 — "⟲ PLAYHEAD" 필 표시용 */
  following: boolean;
  returnToPlayhead: () => void;
}

/**
 * 재생 시작 → ON, 사용자 팬/핀치/줌 버튼/오버뷰 → OFF(각 제스처가 끈다), 필 → ON + 이동 (2026-09-11 스펙 결정 10).
 * follow 자체는 vp.follow shared value에 산다 — 제스처 worklet과 이 훅이 같은 값을 본다.
 */
export function useFollowPlayhead(vp: TimelineViewportState, playheadMs: SharedValue<number>, durationMs: number, playing: boolean): FollowPlayhead {
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (playing) vp.follow.value = true;
  }, [playing, vp.follow]);

  useAnimatedReaction(
    () => vp.follow.value,
    (on, prev) => {
      if (on !== prev) scheduleOnRN(setFollowing, on);
    },
  );

  useAnimatedReaction(
    () => playheadMs.value,
    (ms) => {
      if (!vp.follow.value) return;
      const next = followViewport({ startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value }, ms, durationMs);
      if (next) vp.startMs.value = next.startMs;
    },
    [durationMs],
  );

  const returnToPlayhead = useCallback(() => {
    runOnUI((duration: number) => {
      "worklet";
      vp.follow.value = true;
      const v = { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
      const next = followViewport(v, playheadMs.value, duration);
      if (next) vp.startMs.value = next.startMs;
    })(durationMs);
  }, [vp, playheadMs, durationMs]);

  return { following, returnToPlayhead };
}
