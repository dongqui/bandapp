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

/**
 * 같은 세션 take 목록에서 시간 기준 이웃을 찾는다. 대상 자신은 제외.
 * 2026-10-08: index 순이 아니라 start 순이다 — 수동 take는 index가 제일 크면서 시간상 중간에 들어간다.
 * 대상 index가 목록에 없으면 이웃 없음.
 */
export function neighborsOf(rows: ReadonlyArray<{ index: number; startMs: number; endMs: number }>, index: number): Neighbors {
  const self = rows.find((r) => r.index === index);
  if (!self) return { prevEndMs: null, nextStartMs: null };
  return neighborsAt(
    rows.filter((r) => r.index !== index),
    self.startMs,
  );
}

/**
 * 시각 atMs에 새 take를 넣을 때의 이웃 — start가 atMs보다 앞인 take 중 가장 늦은 end, start가 atMs 이상인 take 중
 * 가장 이른 start. atMs가 어떤 take 안이면 그 take가 앞 이웃이 되어 checkTakeRange가 겹침으로 잡는다.
 */
export function neighborsAt(rows: ReadonlyArray<{ startMs: number; endMs: number }>, atMs: number): Neighbors {
  let prevEndMs: number | null = null;
  let nextStartMs: number | null = null;
  for (const r of rows) {
    if (r.startMs < atMs) {
      if (prevEndMs === null || r.endMs > prevEndMs) prevEndMs = r.endMs;
    } else if (nextStartMs === null || r.startMs < nextStartMs) nextStartMs = r.startMs;
  }
  return { prevEndMs, nextStartMs };
}
