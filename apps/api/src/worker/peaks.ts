/**
 * 파형 피크 계산 — ffmpeg 없이 테스트하는 순수 모듈 (2026-09-10 스펙).
 * 워커는 원본을 한 번 s16le 모노로 디코드해 PeakAccumulator에 흘리고, 세션 전체와 take 구간을
 * slicePeaks로 잘라 PEAK_BUCKETS개로 줄인다.
 */

/** 고해상도 배열의 초당 피크 수. 3시간이면 54만 개(540KB). */
export const PEAKS_PER_SEC = 50;

const INT16_MAX = 32767;
const INITIAL_CAPACITY = 1 << 16;

/** s16le 모노 PCM 청크를 순서대로 받아 창(samplesPerPeak 샘플)마다 max|s|를 0~255로 쌓는다. */
export class PeakAccumulator {
  private buf = new Uint8Array(INITIAL_CAPACITY);
  private length = 0;
  private windowMax = 0;
  private windowCount = 0;
  /** 청크 경계에 걸린 샘플의 하위 바이트 (s16le는 하위 바이트가 먼저 온다) */
  private carry: number | null = null;

  constructor(private readonly samplesPerPeak: number) {
    if (!Number.isInteger(samplesPerPeak) || samplesPerPeak <= 0) {
      throw new Error(`samplesPerPeak must be a positive integer, got ${samplesPerPeak}`);
    }
  }

  push(chunk: Buffer): void {
    let i = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.sample(Buffer.from([this.carry, chunk[0]!]).readInt16LE(0));
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.sample(chunk.readInt16LE(i));
    if (i < chunk.length) this.carry = chunk[i]!;
  }

  /** 마지막 자투리 창도 포함해 지금까지의 피크를 돌려준다. */
  finish(): Uint8Array {
    if (this.windowCount > 0) this.flush();
    return this.buf.slice(0, this.length);
  }

  private sample(s: number): void {
    const a = s < 0 ? -s : s;
    if (a > this.windowMax) this.windowMax = a;
    if (++this.windowCount === this.samplesPerPeak) this.flush();
  }

  private flush(): void {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    // -32768의 절댓값은 INT16_MAX보다 1 크다 — 255를 넘지 않게 자른다
    this.buf[this.length++] = Math.min(255, Math.round((this.windowMax / INT16_MAX) * 255));
    this.windowMax = 0;
    this.windowCount = 0;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * hires의 [startMs, endMs) 구간을 buckets개 창으로 나눠 창 안 max를 취하고, 최댓값이 255가 되도록
 * 정규화한다. 범위는 배열 길이로 clamp하고, 구간이 buckets보다 짧으면 같은 값이 여러 버킷에 반복된다.
 * 범위가 비거나 전부 0이면 전부 0 (스펙 결정 2).
 */
export function slicePeaks(hires: Uint8Array, peaksPerSec: number, startMs: number, endMs: number, buckets: number): number[] {
  const out: number[] = Array.from({ length: buckets }, () => 0);
  const start = clamp(Math.floor((startMs / 1000) * peaksPerSec), 0, hires.length);
  const end = clamp(Math.ceil((endMs / 1000) * peaksPerSec), start, hires.length);
  const span = end - start;
  if (span === 0) return out;
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    const from = start + Math.floor((b * span) / buckets);
    const to = Math.min(end, Math.max(from + 1, start + Math.floor(((b + 1) * span) / buckets)));
    let m = 0;
    for (let i = from; i < to; i++) if (hires[i]! > m) m = hires[i]!;
    out[b] = m;
    if (m > max) max = m;
  }
  if (max === 0) return out;
  return out.map((v) => Math.round((v / max) * 255));
}
