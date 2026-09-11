/**
 * 타임라인 좌표계 (2026-09-11 스펙 §좌표·viewport). 모든 상태는 ms가 기준이고 픽셀은 여기서만 계산한다.
 * 함수마다 "worklet"을 붙여 Reanimated UI 스레드에서 그대로 부른다 — React Native 없이 vitest로 검증한다.
 */
export interface Viewport {
  startMs: number;
  msPerPx: number;
  widthPx: number;
}

/** 최대 줌 — 화면 폭이 5초가 되는 지점 */
export const CLOSEST_WINDOW_MS = 5000;

/** 전체 녹음이 한 화면에 들어오는 msPerPx (가장 넓게) */
export function widestMsPerPx(durationMs: number, widthPx: number): number {
  "worklet";
  return Math.max(1, durationMs) / Math.max(1, widthPx);
}

/** 화면 폭이 5초가 되는 msPerPx (가장 촘촘히). 녹음이 5초보다 짧으면 widest와 같다 — 역전 방지 */
export function closestMsPerPx(durationMs: number, widthPx: number): number {
  "worklet";
  return Math.min(CLOSEST_WINDOW_MS / Math.max(1, widthPx), widestMsPerPx(durationMs, widthPx));
}

export function timeToX(v: Viewport, ms: number): number {
  "worklet";
  return (ms - v.startMs) / v.msPerPx;
}

export function xToTime(v: Viewport, x: number): number {
  "worklet";
  return v.startMs + x * v.msPerPx;
}

export function viewportEndMs(v: Viewport): number {
  "worklet";
  return v.startMs + v.widthPx * v.msPerPx;
}

/**
 * msPerPx를 [closest, widest]로 자른 뒤, 그 폭 기준으로 startMs를 [0, duration − 화면폭]으로 자른다.
 * 순서가 중요하다 — 줌이 정해져야 끝 여백을 계산할 수 있다 (초안 22-H).
 */
export function clampViewport(v: Viewport, durationMs: number): Viewport {
  "worklet";
  const widthPx = Math.max(1, v.widthPx);
  const widest = widestMsPerPx(durationMs, widthPx);
  const closest = closestMsPerPx(durationMs, widthPx);
  const msPerPx = Math.min(widest, Math.max(closest, v.msPerPx));
  const maxStart = Math.max(0, durationMs - widthPx * msPerPx);
  const startMs = Math.min(maxStart, Math.max(0, v.startMs));
  return { startMs, msPerPx, widthPx };
}

/** 손가락이 dxPx만큼 오른쪽으로 가면 과거로 간다 */
export function panViewport(v: Viewport, dxPx: number, durationMs: number): Viewport {
  "worklet";
  return clampViewport({ startMs: v.startMs - dxPx * v.msPerPx, msPerPx: v.msPerPx, widthPx: v.widthPx }, durationMs);
}

/** focalX 아래의 시각이 줌 뒤에도 같은 x에 남는다. scale > 1이 확대. 범위 경계에 걸리면 start만 밀린다 */
export function zoomAtFocal(v: Viewport, focalX: number, scale: number, durationMs: number): Viewport {
  "worklet";
  const focalMs = xToTime(v, focalX);
  const wanted = v.msPerPx / Math.max(1e-6, scale);
  const msPerPx = clampViewport({ startMs: 0, msPerPx: wanted, widthPx: v.widthPx }, durationMs).msPerPx;
  return clampViewport({ startMs: focalMs - focalX * msPerPx, msPerPx, widthPx: v.widthPx }, durationMs);
}

/** [startMs, endMs]가 좌우 padFrac 여백과 함께 보이게. 너무 긴 구간은 전체 보기에서 멈춘다 */
export function fitRange(widthPx: number, startMs: number, endMs: number, padFrac: number, durationMs: number): Viewport {
  "worklet";
  const span = Math.max(1, endMs - startMs);
  const msPerPx = (span * (1 + 2 * padFrac)) / Math.max(1, widthPx);
  return clampViewport({ startMs: startMs - span * padFrac, msPerPx, widthPx }, durationMs);
}

/** 폭이 바뀌어도 화면 중앙 시각을 유지한다 (태블릿 split 등, 초안 22-I) */
export function keepCenterOnResize(v: Viewport, newWidthPx: number, durationMs: number): Viewport {
  "worklet";
  const centerMs = v.startMs + (v.widthPx * v.msPerPx) / 2;
  return clampViewport({ startMs: centerMs - (newWidthPx * v.msPerPx) / 2, msPerPx: v.msPerPx, widthPx: newWidthPx }, durationMs);
}
