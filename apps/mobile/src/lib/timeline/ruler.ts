import { fmtClock } from "../time";
import { timeToX, viewportEndMs, type Viewport } from "./viewport";

/** 눈금 간격 사다리 (초 단위, 디자인 Timeline 화면의 tlTicks와 같다) */
export const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);
/** 한 화면에 들어오는 눈금 수 상한 — 이보다 촘촘해지면 다음 단계로 */
export const MAX_TICKS = 6;

export interface RulerTick {
  xPx: number;
  ms: number;
  label: string;
}

/** 화면에 보이는 길이(ms)에 대해 눈금이 MAX_TICKS개 이하가 되는 첫 단계 */
export function tickStepMs(viewDurationMs: number): number {
  for (const step of TICK_STEPS_MS) if (viewDurationMs / step <= MAX_TICKS) return step;
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
}

/** viewport 안에 있는 step 배수마다 눈금. 라벨은 앱 공통 fmtClock (mm:ss / h:mm:ss) */
export function rulerTicks(v: Viewport): RulerTick[] {
  const step = tickStepMs(v.widthPx * v.msPerPx);
  const first = Math.ceil(v.startMs / step) * step;
  const end = viewportEndMs(v);
  const out: RulerTick[] = [];
  for (let ms = first; ms <= end; ms += step) out.push({ xPx: timeToX(v, ms), ms, label: fmtClock(ms / 1000) });
  return out;
}
