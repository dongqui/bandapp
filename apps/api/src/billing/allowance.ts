import { FREE_SEC, PLANS, type PoolPlan } from "./plans.js";

export type PoolState = "active" | "grace" | "expired";

export interface AllowanceInput {
  /** 밴드가 연결된 풀. 미연결이면 null. reservedSec는 이 풀의 reserved 차감 합 */
  pool: { plan: PoolPlan | null; status: PoolState; usedSec: number; reservedSec: number; periodEnd?: Date | null } | null;
  band: { freeUsedSec: number; extraSec: number };
}

export interface Allowance {
  /** pool = 풀 월 시간을 쓴다, free = 밴드 무료 잔여를 쓴다 */
  source: "pool" | "free";
  monthlyLeftSec: number;
  freeLeftSec: number;
  extraSec: number;
  availableSec: number;
}

/**
 * active인데 기간 끝을 이만큼 넘겼으면 만료 웹훅을 놓친 것으로 보고 비활성 취급한다.
 * 스토어 갱신 지연을 감안해 여유를 둔다. grace는 스토어가 정한 유예라 건드리지 않는다.
 */
export const ACTIVE_STALE_MS = 3 * 24 * 3600_000;

/** 차감 순서 규칙 (스펙 "사용 가능 시간 규칙"). 추가 시간은 밴드 것이라 어느 경우에도 마지막에 쓴다 */
export function allowance({ pool, band }: AllowanceInput, now: Date = new Date()): Allowance {
  const freeLeftSec = Math.max(0, FREE_SEC - band.freeUsedSec);
  const extraSec = Math.max(0, band.extraSec);
  const stale = pool !== null && pool.status === "active" && !!pool.periodEnd && pool.periodEnd.getTime() + ACTIVE_STALE_MS < now.getTime();
  const poolActive = pool !== null && pool.plan !== null && pool.status !== "expired" && !stale;
  if (poolActive) {
    const monthlyLeftSec = Math.max(0, PLANS[pool.plan!].monthlySec - pool.usedSec - pool.reservedSec);
    return { source: "pool", monthlyLeftSec, freeLeftSec, extraSec, availableSec: monthlyLeftSec + extraSec };
  }
  return { source: "free", monthlyLeftSec: 0, freeLeftSec, extraSec, availableSec: freeLeftSec + extraSec };
}

export interface Split {
  freeSec: number;
  monthlySec: number;
  extraSec: number;
}

/** 전부 분석하거나 아예 안 한다 — 부족하면 null */
export function splitCharge(a: Allowance, needSec: number): Split | null {
  if (needSec > a.availableSec) return null;
  const primary = a.source === "pool" ? a.monthlyLeftSec : a.freeLeftSec;
  const fromPrimary = Math.min(primary, needSec);
  const fromExtra = needSec - fromPrimary;
  return a.source === "pool"
    ? { freeSec: 0, monthlySec: fromPrimary, extraSec: fromExtra }
    : { freeSec: fromPrimary, monthlySec: 0, extraSec: fromExtra };
}
