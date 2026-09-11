/** take 최소 길이 (스펙 B 결정 5) */
export const MIN_TAKE_MS = 250;

export type TakeRangeError = "take_range_invalid" | "take_overlap";

/** 같은 세션에서 index가 바로 앞인 take의 endMs, 바로 뒤인 take의 startMs. 없으면 null */
export interface Neighbors {
  prevEndMs: number | null;
  nextStartMs: number | null;
}

/** 경계 규칙 — 정수, 0 ≤ start, end ≤ 길이, 최소 길이, 이웃과 겹침 금지. 통과하면 null */
export function checkTakeRange(startMs: number, endMs: number, durationMs: number, neighbors: Neighbors): TakeRangeError | null {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) return "take_range_invalid";
  if (startMs < 0 || endMs > durationMs || endMs - startMs < MIN_TAKE_MS) return "take_range_invalid";
  if (neighbors.prevEndMs !== null && startMs < neighbors.prevEndMs) return "take_overlap";
  if (neighbors.nextStartMs !== null && endMs > neighbors.nextStartMs) return "take_overlap";
  return null;
}

/** 같은 세션 take 목록에서 index 기준 이웃을 찾는다. 대상 자신은 제외 */
export function neighborsOf(rows: ReadonlyArray<{ index: number; startMs: number; endMs: number }>, index: number): Neighbors {
  let prevEndMs: number | null = null;
  let nextStartMs: number | null = null;
  for (const r of rows) {
    if (r.index < index && (prevEndMs === null || r.endMs > prevEndMs)) prevEndMs = r.endMs;
    if (r.index > index && (nextStartMs === null || r.startMs < nextStartMs)) nextStartMs = r.startMs;
  }
  return { prevEndMs, nextStartMs };
}
