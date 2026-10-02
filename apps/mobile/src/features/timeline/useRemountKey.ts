import { useEffect, useState } from "react";

/** epoch 변경 → 다시 붙이기까지 간격. 바로 다음 프레임에 붙이면 그 프레임의 follow 점프 뒤 파형 path·눈금 갱신이 빠졌다 */
const REMOUNT_DELAY_MS = 120;

/**
 * `epoch`가 바뀌면 조금 뒤에 따라 바뀌는 key. Animated.View에 걸면 그때 뷰가 다시 붙으면서 Reanimated가 그 시점
 * shared value로 style을 강제 재적용한다 (ViewDescriptorsSet.add → updater(true)).
 * 미루는 이유: epoch를 올린 커밋 안에서 바로 다시 붙이면 그 강제 적용도 같이 사라졌고, 바로 다음 프레임에 붙이면
 * 같은 프레임의 다른 mapper 갱신(스크럽을 놓은 뒤 follow 점프에 따른 파형 path·눈금)이 빠졌다 (2026-10-02 기기 검증,
 * useTimelineViewport의 kick 설명 참고).
 */
export function useRemountKey(epoch: string | number): string {
  const [key, setKey] = useState(String(epoch));
  useEffect(() => {
    const id = setTimeout(() => setKey(String(epoch)), REMOUNT_DELAY_MS);
    return () => clearTimeout(id);
  }, [epoch]);
  return key;
}
