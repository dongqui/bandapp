import { useCallback, useEffect, useRef, useState } from "react";
import { useAnimatedReaction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Viewport } from "@/lib/timeline/viewport";
import type { TimelineViewportState } from "./useTimelineViewport";

/** 제스처 중 React로 넘기는 최소 간격. 마지막 값은 trailing으로 반드시 넘어간다 */
const THROTTLE_MS = 80;

function shallowEqual(a: unknown, b: unknown): boolean {
  "worklet";
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  for (const k of ka) if (ra[k] !== rb[k]) return false;
  return true;
}

/**
 * UI 스레드 값을 React state로 미러링한다 (80ms throttle, trailing). 텍스트처럼 UI 스레드에서 못 바꾸는 것(눈금 라벨,
 * 디버그 오버레이)에 쓴다.
 *
 * `inputs`는 `read`가 읽는 shared value 전부다 — Reanimated는 reaction의 입력을 prepare worklet의 클로저에서만 찾는데,
 * `read` 함수 뒤에 숨은 shared value는 못 보므로(함수는 재귀 탐색 대상이 아니다) 여기서 직접 캡처시킨다.
 * `read`는 "worklet"이어야 하고 identity가 안정적이어야 한다(useCallback) — 바뀌면 reaction을 다시 건다.
 */
export function useUiMirror<T extends object | null>(inputs: readonly { readonly value: unknown }[], read: () => T): T | null {
  const [value, setValue] = useState<T | null>(null);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ v: T } | null>(null);

  const push = useCallback((v: T) => {
    const now = Date.now();
    const wait = THROTTLE_MS - (now - lastAt.current);
    if (wait <= 0) {
      lastAt.current = now;
      setValue(v);
      return;
    }
    pending.current = { v };
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      lastAt.current = Date.now();
      const p = pending.current;
      pending.current = null;
      if (p) setValue(p.v);
    }, wait);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useAnimatedReaction(
    () => {
      "worklet";
      // inputs를 본문에서 참조해야 클로저에 잡힌다 — 값은 안 쓴다
      void inputs;
      return read();
    },
    (cur, prev) => {
      if (prev !== null && shallowEqual(cur, prev)) return;
      scheduleOnRN(push, cur);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [read, ...inputs],
  );

  return value;
}

/** viewport 세 값의 미러 — 눈금·필·핸들·오버뷰 창의 기본 style용 */
export function useViewportMirror(vp: TimelineViewportState): Viewport | null {
  const read = useCallback(() => {
    "worklet";
    return { startMs: vp.startMs.value, msPerPx: vp.msPerPx.value, widthPx: vp.widthPx.value };
  }, [vp]);
  return useUiMirror([vp.startMs, vp.msPerPx, vp.widthPx], read);
}
