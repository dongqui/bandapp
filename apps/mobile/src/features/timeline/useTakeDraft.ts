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

  useAnimatedReaction(
    () => draft.value,
    (d, prev) => {
      if (d === prev) return;
      const changed = d !== null && original !== null && (d.startMs !== original.startMs || d.endMs !== original.endMs);
      scheduleOnRN(setDirty, changed);
    },
    [original],
  );

  const begin = useCallback(
    (take: Take, siblings: Take[]) => {
      const o = { startMs: take.startMs, endMs: take.endMs };
      setOriginal(o);
      setDirty(false);
      neighbors.value = neighborsOf(siblings, take.index);
      draft.value = o;
    },
    [draft, neighbors],
  );
  const reset = useCallback(() => {
    if (original) draft.value = { ...original };
    setDirty(false);
  }, [draft, original]);
  const clear = useCallback(() => {
    draft.value = null;
    setOriginal(null);
    setDirty(false);
  }, [draft]);
  const current = useCallback(() => draft.value, [draft]);

  return { draft, neighbors, original, dirty, begin, reset, clear, current };
}
