import type { Draft } from "./edit";

/** 새 take의 기본 길이 — 플레이헤드에서 60초 (2026-10-08 디자인 "Add take") */
export const NEW_TAKE_MS = 60_000;
/** 이만큼 자리가 없으면 만들지 않는다 */
const MIN_ROOM_MS = 1000;

export interface TakeSpan {
  id: string;
  name: string;
  startMs: number;
  endMs: number;
}

export type NewTakeResult = { draft: Draft } | { error: "inside"; take: TakeSpan } | { error: "no_room" };

/**
 * 플레이헤드 위치에 새 take 초안을 만든다. 끝은 60초 뒤·다음 take 시작·녹음 끝 중 가장 이른 곳.
 * 플레이헤드가 기존 take 안이면(시작 포함, 끝 제외) 그 take를 알려 주고, 1초도 자리가 없으면 no_room.
 */
export function newTakeAt(positionMs: number, takes: ReadonlyArray<TakeSpan>, durationMs: number): NewTakeResult {
  const p = Math.round(positionMs);
  const inside = takes.find((t) => p >= t.startMs && p < t.endMs);
  if (inside) return { error: "inside", take: inside };
  const next = takes.reduce((m, t) => (t.startMs > p ? Math.min(m, t.startMs) : m), durationMs);
  if (next - p < MIN_ROOM_MS) return { error: "no_room" };
  return { draft: { startMs: p, endMs: Math.min(p + NEW_TAKE_MS, next) } };
}
