import type { TakeCandidate } from "@bandapp/types";

export interface Chunk {
  index: number;
  startMs: number;
  endMs: number;
}

export interface ChunkOptions {
  chunkMs: number;
  overlapMs: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { chunkMs: 20 * 60_000, overlapMs: 30_000 };

/**
 * 고정 길이 청크 + 앞뒤 겹침 (스펙 결정 2). 청크 i의 본체는 [i*chunkMs, (i+1)*chunkMs)이고
 * 양쪽으로 overlapMs만큼 넓혀 파일 범위로 자른다. 검출기 전처리가 들어오면 이 함수가
 * "후보 구간 목록"을 내는 것으로 바뀐다 — 파이프라인의 다른 부분은 그대로다.
 */
export function planChunks(durationMs: number, opts: ChunkOptions = DEFAULT_CHUNKING): Chunk[] {
  if (!(durationMs > 0)) throw new Error(`durationMs must be positive, got ${durationMs}`);
  const count = Math.max(1, Math.ceil(durationMs / opts.chunkMs));
  return Array.from({ length: count }, (_, index) => ({
    index,
    startMs: Math.max(0, index * opts.chunkMs - opts.overlapMs),
    endMs: Math.min(durationMs, (index + 1) * opts.chunkMs + opts.overlapMs),
  }));
}

export interface MergeOptions {
  minDurationMs: number;
}

export const DEFAULT_MERGE: MergeOptions = { minDurationMs: 20_000 };

/**
 * 겹치거나 맞닿는 후보만 합친다 — 겹침 구간에서 같은 연주가 양쪽 청크에 잡힌 경우가 대상이다.
 * 떨어진 구간의 gap-merge는 하지 않는다 (Gemini 프롬프트가 이미 담당한다고 본다).
 */
export function mergeCandidates(candidates: TakeCandidate[], opts: MergeOptions = DEFAULT_MERGE): TakeCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: TakeCandidate[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, c.endMs);
      last.type = last.type === "PERFORMANCE" || c.type === "PERFORMANCE" ? "PERFORMANCE" : "PARTIAL_PRACTICE";
      last.confidence = Math.max(last.confidence, c.confidence);
    } else {
      merged.push({ ...c });
    }
  }
  return merged.filter((t) => t.endMs - t.startMs >= opts.minDurationMs);
}
