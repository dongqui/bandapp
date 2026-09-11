import { MIN_TAKE_MS, type Neighbors } from "@bandapp/types";
import { timeToX, type Viewport } from "./viewport";

/** 핸들 좌우 터치 영역 (스펙 B 결정 8) */
export const HANDLE_HIT_PX = 24;
/** edge auto pan이 시작되는 가장자리 폭 */
export const EDGE_PX = 24;
/** 가장자리 끝에서의 auto pan 속도 (px/frame) */
export const EDGE_MAX_PX_PER_FRAME = 12;
/** end 핸들을 놓았을 때 미리 듣기 시작점 — 끝나기 2초 전 */
export const PREVIEW_BEFORE_END_MS = 2000;

export type Handle = "start" | "end";

export interface Draft {
  startMs: number;
  endMs: number;
}

/** 손가락 x가 어느 핸들 위인지. 둘 다 맞으면 가까운 쪽 */
export function hitTestHandle(v: Viewport, draft: Draft, xPx: number): Handle | null {
  "worklet";
  const ds = Math.abs(timeToX(v, draft.startMs) - xPx);
  const de = Math.abs(timeToX(v, draft.endMs) - xPx);
  const hitS = ds <= HANDLE_HIT_PX;
  const hitE = de <= HANDLE_HIT_PX;
  if (hitS && hitE) return ds <= de ? "start" : "end";
  if (hitS) return "start";
  if (hitE) return "end";
  return null;
}

/** 한 핸들을 ms로 옮기되 최소 길이·이웃·녹음 범위에서 멈춘다 (결정 5). 정수 ms로 반올림 */
export function trimDraft(draft: Draft, handle: Handle, ms: number, neighbors: Neighbors, durationMs: number): Draft {
  "worklet";
  const t = Math.round(ms);
  if (handle === "start") {
    const lo = Math.max(0, neighbors.prevEndMs ?? 0);
    const hi = draft.endMs - MIN_TAKE_MS;
    return { startMs: Math.min(hi, Math.max(lo, t)), endMs: draft.endMs };
  }
  const lo = draft.startMs + MIN_TAKE_MS;
  const hi = Math.min(durationMs, neighbors.nextStartMs ?? durationMs);
  return { startMs: draft.startMs, endMs: Math.max(lo, Math.min(hi, t)) };
}

/** 손가락이 가장자리 안에 있으면 viewport가 그쪽으로 흐르는 속도. 음수 = 왼쪽(과거) */
export function autoPanPxPerFrame(xPx: number, widthPx: number): number {
  "worklet";
  if (xPx < EDGE_PX) return -Math.min(1, (EDGE_PX - xPx) / EDGE_PX) * EDGE_MAX_PX_PER_FRAME;
  if (xPx > widthPx - EDGE_PX) return Math.min(1, (xPx - (widthPx - EDGE_PX)) / EDGE_PX) * EDGE_MAX_PX_PER_FRAME;
  return 0;
}

/** 핸들을 놓은 뒤 미리 듣기 위치 */
export function previewSeekMs(draft: Draft, handle: Handle): number {
  "worklet";
  return handle === "start" ? draft.startMs : Math.max(draft.startMs, draft.endMs - PREVIEW_BEFORE_END_MS);
}

/** 코멘트 atSec(take 상대, 초)를 start 이동에 맞춰 옮긴다 — 절대 시각 보존 (결정 2) */
export function shiftCommentAtSec(atSec: number, oldStartMs: number, newStartMs: number): number {
  "worklet";
  return atSec + (oldStartMs - newStartMs) / 1000;
}
