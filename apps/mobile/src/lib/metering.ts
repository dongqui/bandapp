/**
 * 녹음 중 라이브 파형용 미터링 변환 (2026-10-12 스펙 결정 2).
 * expo-audio의 metering은 dB(iOS averagePower, Android maxAmplitude 환산)이고 무음은 -160이다.
 * 합주실 소리는 -30 dB 위에서 주로 움직이므로 -60을 바닥으로 잡는다. 기기에서 보고 조정한다.
 */
export const METER_FLOOR_DB = -60;
export const METER_CEIL_DB = 0;

/** expo-audio metering(dB) → 0~1. undefined·NaN·무음은 0, 범위 밖은 clamp. */
export function dbToUnit(db: number | undefined): number {
  if (db === undefined || Number.isNaN(db)) return 0;
  const unit = (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
  return Math.min(1, Math.max(0, unit));
}

/** levels 끝에 unit을 붙이고 최근 size개만 남긴다. 입력은 건드리지 않고 새 배열을 돌려준다. */
export function pushLevel(levels: number[], unit: number, size: number): number[] {
  if (size <= 0) return [];
  const next = [...levels, unit];
  return next.length > size ? next.slice(next.length - size) : next;
}
