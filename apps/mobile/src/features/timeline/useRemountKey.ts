import { useEffect, useState } from "react";

/**
 * `epoch`가 바뀌면 한 프레임 뒤에 따라 바뀌는 key. Animated.View에 걸면 그때 뷰가 다시 붙으면서 Reanimated가 그 시점
 * shared value로 style을 강제 재적용한다 (ViewDescriptorsSet.add → updater(true)).
 * 한 프레임 미루는 이유: epoch를 올린 커밋 안에서 바로 다시 붙이면 그 강제 적용도 같이 사라졌다 (2026-10-02 기기 검증,
 * useTimelineViewport의 kick 설명 참고).
 */
export function useRemountKey(epoch: string | number): string {
  const [key, setKey] = useState(String(epoch));
  useEffect(() => {
    const id = requestAnimationFrame(() => setKey(String(epoch)));
    return () => cancelAnimationFrame(id);
  }, [epoch]);
  return key;
}
