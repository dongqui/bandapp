import { useEffect, useState } from "react";

/** epoch 변경 → 다시 붙이기까지 간격. 바로 다음 프레임에 붙이면 그 프레임의 follow 점프 뒤 파형 path·눈금 갱신이 빠졌다 */
const REMOUNT_DELAY_MS = 120;

/**
 * `epoch`가 바뀌면 조금 뒤에 따라 바뀌는 key. Animated.View에 걸면 그때 뷰가 다시 붙으면서 Reanimated가 그 시점
 * shared value로 style을 강제 재적용한다 (ViewDescriptorsSet.add → updater(true)).
 * 미루는 이유: epoch를 올린 커밋 안에서 바로 다시 붙이면 그 강제 적용도 같이 사라졌고, 바로 다음 프레임에 붙이면
 * 같은 프레임의 다른 mapper 갱신(스크럽을 놓은 뒤 follow 점프에 따른 파형 path·눈금)이 빠졌다 (2026-10-02 기기 검증,
 * useTimelineViewport의 kick 설명 참고).
 * key는 **`useAnimatedStyle`을 가진 컴포넌트**에 걸어야 한다. Reanimated는 다시 붙는 뷰의 마운트 초기값을 훅이 처음 만들어질 때의
 * updater 클로저로 계산한다(PropsFilter → initialUpdaterRun(initial.updater)). Animated.View에만 key를 걸면 훅은 그대로라
 * 첫 렌더 클로저(레이아웃 전 width 0 등)로 계산한 초기값이 한 프레임 보였다가 updater(true)가 고쳤다 — take 이동마다 노브가 0으로,
 * 오버뷰 창이 왼쪽으로 깜빡인 원인 (2026-10-02 기기 보고).
 */
export function useRemountKey(epoch: string | number): string {
  const [key, setKey] = useState(String(epoch));
  useEffect(() => {
    const id = setTimeout(() => setKey(String(epoch)), REMOUNT_DELAY_MS);
    return () => clearTimeout(id);
  }, [epoch]);
  return key;
}
