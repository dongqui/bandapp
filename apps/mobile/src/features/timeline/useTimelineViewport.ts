import { useCallback, useEffect } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  useCompetingGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
  type ComposedGesture,
} from "react-native-gesture-handler";
import { runOnUI, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { clampViewport, keepCenterOnResize, panViewport, widestMsPerPx, zoomAtFocal, type Viewport } from "@/lib/timeline/viewport";

export type ActiveGesture = "pan" | "pinch" | null;

export interface TimelineViewportState {
  startMs: SharedValue<number>;
  msPerPx: SharedValue<number>;
  widthPx: SharedValue<number>;
  /** 재생 위치 따라가기 — 제스처가 시작되면 여기서 끈다 (스펙 결정 10) */
  follow: SharedValue<boolean>;
  activeGesture: SharedValue<ActiveGesture>;
  gesture: ComposedGesture;
  onLayout: (e: LayoutChangeEvent) => void;
  /** JS에서 viewport를 통째로 바꾼다 (take fit 등). clamp된다 */
  setViewport: (v: Viewport) => void;
  /** 화면 중앙 기준 줌 (디자인의 −/+ 버튼). scale > 1 확대. 사용자 이동이라 follow를 끈다 */
  zoomBy: (scale: number) => void;
  /** JS에서 현재 viewport를 읽는다 (탭 → 시각 변환) */
  snapshot: () => Viewport;
}

/**
 * viewport 두 값(startMs, msPerPx)은 shared value로만 살고 React state가 없다 (2026-09-11 스펙 §상태 구분).
 * 팬은 changeX 증분을 현재 viewport에 더하고, 핀치는 onBegin 시점 viewport 기준 절대 scale로 계산한다.
 * 둘이 동시에 오면 팬이 핀치 origin의 startMs도 같이 밀어 서로 덮어쓰지 않는다 (결정 8, 초안 22-G).
 * 모든 콜백은 UI 스레드 worklet — React 리렌더 없이 매 프레임 갱신된다.
 */
export function useTimelineViewport(durationMs: number, onTap: (xPx: number, yPx: number) => void): TimelineViewportState {
  const startMs = useSharedValue(0);
  const msPerPx = useSharedValue(1);
  const widthPx = useSharedValue(0);
  const follow = useSharedValue(false);
  const activeGesture = useSharedValue<ActiveGesture>(null);
  const pinchOrigin = useSharedValue<Viewport | null>(null);

  const pan = usePanGesture({
    activeOffsetX: [-6, 6],
    onBegin: () => {
      "worklet";
      follow.value = false;
      activeGesture.value = "pan";
    },
    onUpdate: (e) => {
      "worklet";
      const v = panViewport({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, e.changeX, durationMs);
      startMs.value = v.startMs;
      const o = pinchOrigin.value;
      if (o) pinchOrigin.value = { startMs: o.startMs - e.changeX * o.msPerPx, msPerPx: o.msPerPx, widthPx: o.widthPx };
    },
    onFinalize: () => {
      "worklet";
      activeGesture.value = null;
    },
  });

  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      follow.value = false;
      activeGesture.value = "pinch";
      pinchOrigin.value = { startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value };
    },
    onUpdate: (e) => {
      "worklet";
      const o = pinchOrigin.value;
      if (!o) return;
      const v = zoomAtFocal(o, e.focalX, e.scale, durationMs);
      startMs.value = v.startMs;
      msPerPx.value = v.msPerPx;
    },
    onFinalize: () => {
      "worklet";
      pinchOrigin.value = null;
      activeGesture.value = null;
    },
  });

  const tap = useTapGesture({
    onActivate: (e) => {
      "worklet";
      scheduleOnRN(onTap, e.x, e.y);
    },
  });

  const panPinch = useSimultaneousGestures(pan, pinch);
  const gesture = useCompetingGestures(panPinch, tap);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const width = e.nativeEvent.layout.width;
      runOnUI((w: number, duration: number) => {
        "worklet";
        if (widthPx.value === 0) {
          widthPx.value = w;
          msPerPx.value = widestMsPerPx(duration, w);
          startMs.value = 0;
          return;
        }
        if (w === widthPx.value) return;
        const v = keepCenterOnResize({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, w, duration);
        widthPx.value = v.widthPx;
        msPerPx.value = v.msPerPx;
        startMs.value = v.startMs;
      })(width, durationMs);
    },
    [durationMs, widthPx, msPerPx, startMs],
  );

  // duration이 늦게 들어오거나 바뀌면 지금 viewport를 다시 clamp한다
  useEffect(() => {
    runOnUI((duration: number) => {
      "worklet";
      if (widthPx.value === 0) return;
      const v = clampViewport({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, duration);
      startMs.value = v.startMs;
      msPerPx.value = v.msPerPx;
    })(durationMs);
  }, [durationMs, widthPx, msPerPx, startMs]);

  const setViewport = useCallback(
    (next: Viewport) => {
      runOnUI((v: Viewport, duration: number) => {
        "worklet";
        const c = clampViewport(v, duration);
        startMs.value = c.startMs;
        msPerPx.value = c.msPerPx;
      })(next, durationMs);
    },
    [durationMs, startMs, msPerPx],
  );

  const zoomBy = useCallback(
    (scale: number) => {
      runOnUI((s: number, duration: number) => {
        "worklet";
        follow.value = false;
        const v = { startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value };
        const z = zoomAtFocal(v, v.widthPx / 2, s, duration);
        startMs.value = z.startMs;
        msPerPx.value = z.msPerPx;
      })(scale, durationMs);
    },
    [durationMs, follow, startMs, msPerPx, widthPx],
  );

  const snapshot = useCallback(
    (): Viewport => ({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }),
    [startMs, msPerPx, widthPx],
  );

  return { startMs, msPerPx, widthPx, follow, activeGesture, gesture, onLayout, setViewport, zoomBy, snapshot };
}
