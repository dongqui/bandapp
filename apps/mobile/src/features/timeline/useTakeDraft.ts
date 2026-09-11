import { neighborsOf, type Neighbors, type Take } from "@bandapp/types";
import { useCallback, useState } from "react";
import { useAnimatedReaction, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Draft } from "@/lib/timeline/edit";

export interface TakeDraftState {
  /** 핸들 드래그가 매 프레임 바꾸는 초안. null이면 편집 중 아님 */
  draft: SharedValue<Draft | null>;
  neighbors: SharedValue<Neighbors>;
  /** 선택한 take의 저장된 경계 — Cancel이 되돌리는 값 */
  original: Draft | null;
  /** 초안이 저장된 값과 다른가 (React 미러) */
  dirty: boolean;
  begin: (take: Take, siblings: Take[]) => void;
  /** Cancel — 초안을 저장된 값으로 */
  reset: () => void;
  /** 선택 해제 */
  clear: () => void;
  /** JS에서 초안 읽기 (Save) */
  current: () => Draft | null;
}

/** 초안은 shared value로만 살고(스펙 B 결정 7) React는 dirty 여부만 안다 */
export function useTakeDraft(): TakeDraftState {
  const draft = useSharedValue<Draft | null>(null);
  const neighbors = useSharedValue<Neighbors>({ prevEndMs: null, nextStartMs: null });
  const [original, setOriginal] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  // original의 shared value 미러 — begin()이 draft.value를 바로 바꾸는데 React state(original)는
  // 나중에 커밋되므로, reaction worklet이 React 값을 보면 take 전환 때 이전 take 기준으로 dirty를 오판한다
  const originalSV = useSharedValue<Draft | null>(null);
  // 매 프레임 draft가 바뀌어도 dirty 값 자체가 안 바뀌면 JS로 안 넘긴다
  const lastDirty = useSharedValue(false);

  useAnimatedReaction(
    () => draft.value,
    (d) => {
      const o = originalSV.value;
      const changed = d !== null && o !== null && (d.startMs !== o.startMs || d.endMs !== o.endMs);
      if (changed !== lastDirty.value) {
        lastDirty.value = changed;
        scheduleOnRN(setDirty, changed);
      }
    },
    [],
  );

  const begin = useCallback(
    (take: Take, siblings: Take[]) => {
      const o = { startMs: take.startMs, endMs: take.endMs };
      setOriginal(o);
      setDirty(false);
      neighbors.value = neighborsOf(siblings, take.index);
      // originalSV를 draft보다 먼저 갱신해야 reaction worklet이 새 take 기준으로 dirty를 계산한다
      originalSV.value = o;
      lastDirty.value = false;
      draft.value = o;
    },
    [draft, neighbors, originalSV, lastDirty],
  );
  const reset = useCallback(() => {
    if (original) draft.value = { ...original };
    lastDirty.value = false;
    setDirty(false);
  }, [draft, original, lastDirty]);
  const clear = useCallback(() => {
    draft.value = null;
    originalSV.value = null;
    lastDirty.value = false;
    setOriginal(null);
    setDirty(false);
  }, [draft, originalSV, lastDirty]);
  const current = useCallback(() => draft.value, [draft]);

  return { draft, neighbors, original, dirty, begin, reset, clear, current };
}
