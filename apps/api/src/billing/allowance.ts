import { FREE_SEC, PLANS, type PoolPlan } from "./plans.js";

export type PoolState = "active" | "grace" | "expired";

export interface AllowanceInput {
  /** 밴드가 연결된 풀. 미연결이면 null. reservedSec는 이 풀의 reserved 차감 합 */
  pool: { plan: PoolPlan | null; status: PoolState; usedSec: number; reservedSec: number } | null;
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

/** 차감 순서 규칙 (스펙 "사용 가능 시간 규칙"). 추가 시간은 밴드 것이라 어느 경우에도 마지막에 쓴다 */
export function allowance({ pool, band }: AllowanceInput): Allowance {
  const freeLeftSec = Math.max(0, FREE_SEC - band.freeUsedSec);
  const extraSec = Math.max(0, band.extraSec);
  const poolActive = pool !== null && pool.plan !== null && pool.status !== "expired";
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
