import { clampViewport, timeToX, type Viewport } from "./viewport";

/** playhead가 화면 폭의 이 비율을 넘으면 viewport를 옮긴다 (2026-09-11 스펙 결정 10, 초안 14절) */
export const FOLLOW_TRIGGER_FRAC = 0.8;
/** 옮긴 뒤 playhead가 놓이는 위치 */
export const FOLLOW_RESET_FRAC = 0.3;

/** follow가 켜져 있을 때 viewport를 옮겨야 하면 새 viewport, 아니면 null. 애니메이션 없이 점프한다 */
export function followViewport(v: Viewport, playheadMs: number, durationMs: number): Viewport | null {
  "worklet";
  const x = timeToX(v, playheadMs);
  if (x >= 0 && x <= v.widthPx * FOLLOW_TRIGGER_FRAC) return null;
  return clampViewport(
    { startMs: playheadMs - v.widthPx * FOLLOW_RESET_FRAC * v.msPerPx, msPerPx: v.msPerPx, widthPx: v.widthPx },
    durationMs,
  );
}

/** playhead가 화면 밖이면 어느 쪽인지 — 가장자리 표시용 */
export function playheadEdge(v: Viewport, playheadMs: number): "left" | "right" | null {
  "worklet";
  const x = timeToX(v, playheadMs);
  if (x < 0) return "left";
  if (x > v.widthPx) return "right";
  return null;
}
