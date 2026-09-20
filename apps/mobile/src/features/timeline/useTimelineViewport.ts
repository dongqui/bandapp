import { useCallback, useEffect, useMemo } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  useCompetingGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
  type ComposedGesture,
} from "react-native-gesture-handler";
import { runOnUI, useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Neighbors } from "@bandapp/types";
import { autoPanPxPerFrame, hitTestHandle, trimDraft, type Draft, type Handle } from "@/lib/timeline/edit";
import { clampViewport, fitRange, keepCenterOnResize, panViewport, widestMsPerPx, xToTime, zoomAtFocal, type Viewport } from "@/lib/timeline/viewport";

export type ActiveGesture = "pan" | "pinch" | null;
export type EditMode = "handle-start" | "handle-end" | null;

export interface EditingBindings {
  draft: SharedValue<Draft | null>;
  neighbors: SharedValue<Neighbors>;
  /** 핸들을 놓았을 때 (JS) — 미리 듣기 seek */
  onHandleRelease: (handle: Handle, draft: Draft) => void;
}

export interface TimelineViewportState {
  startMs: SharedValue<number>;
  msPerPx: SharedValue<number>;
  widthPx: SharedValue<number>;
  /** 재생 위치 따라가기 — 제스처가 시작되면 여기서 끈다 (스펙 결정 10) */
  follow: SharedValue<boolean>;
  activeGesture: SharedValue<ActiveGesture>;
  onLayout: (e: LayoutChangeEvent) => void;
  /** JS에서 viewport를 통째로 바꾼다 (take fit 등). clamp된다 */
  setViewport: (v: Viewport) => void;
  /** [startMs, endMs]가 좌우 padFrac 여백으로 보이게 맞춘다 (take 선택). 아직 폭을 모르면 첫 레이아웃 때 적용된다 */
  fitTo: (startMs: number, endMs: number, padFrac: number) => void;
  /** JS에서 현재 viewport를 읽는다 (탭 → 시각 변환) */
  snapshot: () => Viewport;
  /** 핸들 드래그 중이면 어느 핸들인지 (스펙 B 결정 8) */
  editMode: SharedValue<EditMode>;
}

/**
 * 반환 shape. gesture는 state 객체 밖에 둔다 — 컴포넌트들이 worklet 안에서 `vp.startMs.value`처럼 state 객체를
 * 통째로 캡처하는데, gesture(클래스 인스턴스, 내부에 Reanimated WorkletEventHandlerNative)는 UI 런타임으로
 * 복사할 수 없어 네이티브에서 "[Worklets] Cannot copy value of type WorkletEventHandlerNative"로 죽는다.
 * (웹은 복사 과정이 없어 안 났다 — 2026-09-12 기기 검증에서 발견)
 */
export interface TimelineViewportHandle {
  vp: TimelineViewportState;
  gesture: ComposedGesture;
}

/**
 * viewport 두 값(startMs, msPerPx)은 shared value로만 살고 React state가 없다 (2026-09-11 스펙 §상태 구분).
 * 팬은 changeX 증분을 현재 viewport에 더하고, 핀치는 onBegin 시점 viewport 기준 절대 scale로 계산한다.
 * 둘이 동시에 오면 팬이 핀치 origin의 startMs도 같이 밀어 서로 덮어쓰지 않는다 (결정 8, 초안 22-G).
 * 모든 콜백은 UI 스레드 worklet — React 리렌더 없이 매 프레임 갱신된다.
 */
export function useTimelineViewport(
  durationMs: number,
  onTap: (xPx: number, yPx: number) => void,
  editing?: EditingBindings,
): TimelineViewportHandle {
  const startMs = useSharedValue(0);
  const msPerPx = useSharedValue(1);
  const widthPx = useSharedValue(0);
  // 처음에는 ON — 제스처가 끄고, 재생 시작·seek·take 선택이 다시 켠다 (2026-09-20 개정에서 "⟲ PLAYHEAD" 필이 빠졌다)
  const follow = useSharedValue(true);
  const activeGesture = useSharedValue<ActiveGesture>(null);
  const pinchOrigin = useSharedValue<Viewport | null>(null);
  // 폭을 알기 전에 들어온 fitTo 요청
  const pendingFit = useSharedValue<{ startMs: number; endMs: number; padFrac: number } | null>(null);
  // 핸들 드래그 상태 (스펙 B) — 잡은 핸들과 마지막 손가락 x
  const editMode = useSharedValue<EditMode>(null);
  const fingerX = useSharedValue(0);
  // onBegin은 팬이 활성화되기 전(탭에서도) 불린다 — 실제로 핸들이 움직였을 때만 onHandleRelease를 예약한다
  const handleMoved = useSharedValue(false);

  /** 핸들 모드일 때 초안을 손가락 아래 시각으로 옮긴다 */
  const moveHandleTo = (mode: EditMode, xPx: number) => {
    "worklet";
    if (!editing || !mode) return;
    const d = editing.draft.value;
    if (!d) return;
    const v = { startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value };
    const handle: Handle = mode === "handle-start" ? "start" : "end";
    editing.draft.value = trimDraft(d, handle, xToTime(v, xPx), editing.neighbors.value, durationMs);
  };

  const pan = usePanGesture({
    activeOffsetX: [-6, 6],
    onBegin: (e) => {
      "worklet";
      follow.value = false;
      handleMoved.value = false;
      const d = editing?.draft.value ?? null;
      const v = { startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value };
      const hit = d ? hitTestHandle(v, d, e.x) : null;
      if (hit) {
        editMode.value = hit === "start" ? "handle-start" : "handle-end";
        fingerX.value = e.x;
        activeGesture.value = "pan";
        return;
      }
      editMode.value = null;
      activeGesture.value = "pan";
    },
    onUpdate: (e) => {
      "worklet";
      if (editMode.value) {
        fingerX.value = e.x;
        handleMoved.value = true;
        moveHandleTo(editMode.value, e.x);
        return;
      }
      const v = panViewport({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, e.changeX, durationMs);
      startMs.value = v.startMs;
      const o = pinchOrigin.value;
      if (o) pinchOrigin.value = { startMs: o.startMs - e.changeX * o.msPerPx, msPerPx: o.msPerPx, widthPx: o.widthPx };
    },
    onFinalize: () => {
      "worklet";
      const mode = editMode.value;
      editMode.value = null;
      activeGesture.value = null;
      // onBegin은 탭에서도 불리므로, 실제로 핸들을 움직였을 때만 release를 예약한다 (탭 제스처의 seek와 경합 방지)
      if (mode && editing && handleMoved.value) {
        const d = editing.draft.value;
        if (d) scheduleOnRN(editing.onHandleRelease, mode === "handle-start" ? "start" : "end", d);
      }
    },
  });

  const pinch = usePinchGesture({
    onBegin: () => {
      "worklet";
      if (editMode.value) return;
      follow.value = false;
      activeGesture.value = "pinch";
      pinchOrigin.value = { startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value };
    },
    onUpdate: (e) => {
      "worklet";
      if (editMode.value) return;
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

  // 핸들을 잡은 채 가장자리에 닿으면 viewport가 그쪽으로 흐르고 핸들은 손가락 아래 시각을 따라간다 (초안 20절)
  useFrameCallback(() => {
    const mode = editMode.value;
    if (!mode || !editing) return;
    const dx = autoPanPxPerFrame(fingerX.value, widthPx.value);
    if (dx === 0) return;
    const v = panViewport({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }, -dx, durationMs);
    startMs.value = v.startMs;
    handleMoved.value = true;
    moveHandleTo(mode, fingerX.value);
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
          const fit = pendingFit.value;
          pendingFit.value = null;
          if (fit) {
            const v = fitRange(w, fit.startMs, fit.endMs, fit.padFrac, duration);
            startMs.value = v.startMs;
            msPerPx.value = v.msPerPx;
            return;
          }
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
    [durationMs, widthPx, msPerPx, startMs, pendingFit],
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

  const fitTo = useCallback(
    (fromMs: number, toMs: number, padFrac: number) => {
      runOnUI((a: number, b: number, pad: number, duration: number) => {
        "worklet";
        if (widthPx.value === 0) {
          // 첫 take 자동 선택은 레이아웃보다 먼저 올 수 있다 — onLayout이 이어받는다
          pendingFit.value = { startMs: a, endMs: b, padFrac: pad };
          return;
        }
        const v = fitRange(widthPx.value, a, b, pad, duration);
        startMs.value = v.startMs;
        msPerPx.value = v.msPerPx;
      })(fromMs, toMs, padFrac, durationMs);
    },
    [durationMs, pendingFit, startMs, msPerPx, widthPx],
  );

  const snapshot = useCallback(
    (): Viewport => ({ startMs: startMs.value, msPerPx: msPerPx.value, widthPx: widthPx.value }),
    [startMs, msPerPx, widthPx],
  );

  // shared value·콜백은 전부 안정적이라 vp 객체 identity도 안정적이다 — 이를 deps로 쓰는 useCallback이 매 렌더 새로 만들어지지 않는다
  const vp = useMemo<TimelineViewportState>(
    () => ({ startMs, msPerPx, widthPx, follow, activeGesture, onLayout, setViewport, fitTo, snapshot, editMode }),
    [startMs, msPerPx, widthPx, follow, activeGesture, onLayout, setViewport, fitTo, snapshot, editMode],
  );
  return { vp, gesture };
}
