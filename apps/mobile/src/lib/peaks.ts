/**
 * 서버 피크(길이 PEAK_BUCKETS, 0~255)를 화면 바 개수에 맞춰 줄인다 (2026-09-10 스펙).
 * 창 안 max를 취해 봉우리를 살리고, null이면 전부 0 → 모든 바가 최소 높이 = 평평한 플레이스홀더.
 */
export function resamplePeaks(peaks: number[] | null, bars: number): number[] {
  const out: number[] = Array.from({ length: bars }, () => 0);
  if (!peaks || peaks.length === 0) return out;
  const n = peaks.length;
  for (let b = 0; b < bars; b++) {
    const from = Math.floor((b * n) / bars);
    const to = Math.min(n, Math.max(from + 1, Math.floor(((b + 1) * n) / bars)));
    let m = 0;
    for (let i = from; i < to; i++) if (peaks[i]! > m) m = peaks[i]!;
    out[b] = m / 255;
  }
  return out;
}

/** 바 높이 — 시드 파형 때와 같은 공식. 표시 곡선을 바꾸고 싶으면 여기 한 곳만 고친다. */
export function barHeight(unit: number, height: number, minPx: number): number {
  return Math.max(minPx, Math.round((0.12 + 0.88 * unit) * height));
}
