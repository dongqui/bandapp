import { xToTime, type Viewport } from "./viewport";

/** LOD 피라미드 (2026-09-11 스펙 결정 13). levels[k]의 원소 하나는 hires 피크 2^k개의 max */
export interface PeakLevels {
  levels: Uint8Array[];
  peaksPerSec: number;
  /** hires 전체 최댓값 — 정규화 기준 (결정 6). 무음이면 0 */
  max: number;
}

/** 이 길이 이하가 되면 더 접지 않는다 */
export const LEVEL_MIN_LENGTH = 512;
/** 파형 컬럼 피치(px). 디자인의 폴리곤 파형이 약 2px마다 점을 찍는다 */
export const BAR_PX = 2;
/** hysteresis: 바당 피크가 이보다 많으면 한 단계 거칠게 */
export const PEAKS_PER_BAR_COARSER = 3.5;
/** 바당 피크가 이보다 적으면 한 단계 세밀하게 */
export const PEAKS_PER_BAR_FINER = 0.8;

export function buildLevels(hires: Uint8Array, peaksPerSec: number): PeakLevels {
  let max = 0;
  for (let i = 0; i < hires.length; i++) if (hires[i]! > max) max = hires[i]!;
  const levels: Uint8Array[] = [hires];
  let cur = hires;
  while (cur.length > LEVEL_MIN_LENGTH) {
    const next = new Uint8Array(Math.ceil(cur.length / 2));
    for (let i = 0; i < next.length; i++) {
      const a = cur[2 * i]!;
      const b = 2 * i + 1 < cur.length ? cur[2 * i + 1]! : 0;
      next[i] = a > b ? a : b;
    }
    levels.push(next);
    cur = next;
  }
  return { levels, peaksPerSec, max };
}

/** 128버킷(Session.peaks) 폴백 — 레벨 하나짜리 피라미드. 버킷 하나가 duration/128 ms (결정 14) */
export function bucketsToLevels(buckets: number[], durationMs: number): PeakLevels {
  return buildLevels(Uint8Array.from(buckets), (buckets.length * 1000) / Math.max(1, durationMs));
}

/** 레벨 k에서 바 하나(barPx)에 들어가는 피크 수 */
export function peaksPerBar(p: PeakLevels, level: number, msPerPx: number, barPx: number): number {
  "worklet";
  return (((barPx * msPerPx) / 1000) * p.peaksPerSec) / 2 ** level;
}

/**
 * 현재 레벨 기준 hysteresis — 바당 피크가 3.5를 넘으면 거칠게, 0.8 미만이면 세밀하게. 인접 레벨은 2배 차이라
 * 한 번 옮기면 [1.75, 3.5) 또는 (0.8, 1.6]에 들어가 다시 튀지 않는다. current가 범위 밖(-1)이면 처음 고른다.
 */
export function selectLevel(p: PeakLevels, msPerPx: number, barPx: number, current: number): number {
  "worklet";
  const last = p.levels.length - 1;
  let k = current;
  if (k < 0 || k > last) {
    k = 0;
    while (k < last && peaksPerBar(p, k, msPerPx, barPx) > 2) k++;
    return k;
  }
  while (k < last && peaksPerBar(p, k, msPerPx, barPx) > PEAKS_PER_BAR_COARSER) k++;
  while (k > 0 && peaksPerBar(p, k, msPerPx, barPx) < PEAKS_PER_BAR_FINER) k--;
  return k;
}

/** viewport의 바마다 0~1 높이. 바 b는 [b·barPx, (b+1)·barPx) 픽셀 구간에 걸친 피크의 max / 전체 max */
export function barsForViewport(p: PeakLevels, level: number, v: Viewport, barPx: number): number[] {
  "worklet";
  const data = p.levels[level]!;
  const perPeakMs = (1000 * 2 ** level) / p.peaksPerSec;
  const bars = Math.floor(v.widthPx / barPx);
  const out: number[] = [];
  for (let b = 0; b < bars; b++) {
    let i0 = Math.floor(xToTime(v, b * barPx) / perPeakMs);
    let i1 = Math.ceil(xToTime(v, (b + 1) * barPx) / perPeakMs);
    if (i1 <= i0) i1 = i0 + 1;
    if (i0 < 0) i0 = 0;
    if (i1 > data.length) i1 = data.length;
    let m = 0;
    for (let i = i0; i < i1; i++) if (data[i]! > m) m = data[i]!;
    out.push(p.max > 0 ? m / p.max : 0);
  }
  return out;
}
