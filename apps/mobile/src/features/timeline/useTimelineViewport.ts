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
import { runOnUI, useFrameCallback, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Neighbors } from "@bandapp/types";
import { autoPanPxPerFrame, hitTestHandle, trimDraft, type Draft, type Handle } from "@/lib/timeline/edit";
import { clampViewport, keepCenterOnResize, panViewport, widestMsPerPx, xToTime, zoomAtFocal, type Viewport } from "@/lib/timeline/viewport";

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
  gesture: ComposedGesture;
  onLayout: (e: LayoutChangeEvent) => void;
  /** JS에서 viewport를 통째로 바꾼다 (take fit 등). clamp된다 */
  setViewport: (v: Viewport) => void;
  /** 화면 중앙 기준 줌 (디자인의 −/+ 버튼). scale > 1 확대. 사용자 이동이라 follow를 끈다 */
  zoomBy: (scale: number) => void;
  /** JS에서 현재 viewport를 읽는다 (탭 → 시각 변환) */
  snapshot: () => Viewport;
  /** 핸들 드래그 중이면 어느 핸들인지 (스펙 B 결정 8) */
  editMode: SharedValue<EditMode>;
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
): TimelineViewportState {
  const startMs = useSharedValue(0);
  const msPerPx = useSharedValue(1);
  const widthPx = useSharedValue(0);
  // 처음에는 ON — 디자인(tlFollow: true)대로 "⟲ PLAYHEAD" 필이 사용자가 움직인 뒤에만 보인다
  const follow = useSharedValue(true);
  const activeGesture = useSharedValue<ActiveGesture>(null);
  const pinchOrigin = useSharedValue<Viewport | null>(null);
  // 핸들 드래그 상태 (스펙 B) — 잡은 핸들과 마지막 손가락 x
  const editMode = useSharedValue<EditMode>(null);
  const fingerX = useSharedValue(0);

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
      if (mode && editing) {
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

  return { startMs, msPerPx, widthPx, follow, activeGesture, gesture, onLayout, setViewport, zoomBy, snapshot, editMode };
}
