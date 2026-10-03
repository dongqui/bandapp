import type { BandBilling, PoolPlan } from "@bandapp/types";
import type { ProductKey } from "../../services/purchases";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 디자인 프로토타입 fmtH: 분 단위 반올림, "2h 30m" / "45m" / "0h" */
export function fmtH(sec: number): string {
  const m = Math.round(Math.max(0, sec) / 60);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!m) return "0h";
  if (h && r) return `${h}h ${r}m`;
  return h ? `${h}h` : `${r}m`;
}

export function monthDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export type PurchasePhase = "checking" | "success" | "failed" | "pending" | "delayed" | "canceled" | "resumed";

/** 구매 결과 + sync 뒤 상태 → B06 화면 (디자인 P 테이블). 스토어는 됐는데 서버가 아직이면 delayed */
export function phaseAfterSync(
  outcome: "success" | "pending" | "failed",
  before: BandBilling,
  after: BandBilling | null,
  product: ProductKey,
): PurchasePhase {
  if (outcome !== "success") return outcome;
  if (!after) return "delayed";
  if (product === "extra") return after.extraSec > before.extraSec ? "success" : "delayed";
  return after.state === "linked" && after.plan === product ? "success" : "delayed";
}

/**
 * 요청자(오너)가 지금 구독 중인 플랜. 밴드가 아니라 풀에서 읽는다 — 미연결 밴드에서 결제 화면에 들어와도
 * 이미 구독 중이면 "변경"으로 다뤄야 Android에서 구독이 둘로 생기지 않는다.
 * 멤버는 myPool이 없으므로 연결된 밴드의 플랜을 쓴다.
 */
export function currentPlanOf(b: BandBilling): PoolPlan | null {
  if (b.myPool && b.myPool.plan && b.myPool.status !== "expired") return b.myPool.plan;
  return b.state === "linked" ? b.plan : null;
}

export type NoTimeAction = "viewPlans" | "resubscribe" | "addToPlan" | "buyExtra" | "viewPlus" | "notNow";

/** B03 시트 버튼 (디자인 ntActions) */
export function noTimeActions(b: BandBilling, _needSec: number): NoTimeAction[] {
  if (!b.isOwner) return b.state === "linked" ? ["buyExtra", "notNow"] : ["notNow"];
  if (b.state === "linked") return b.plan === "band" ? ["buyExtra", "viewPlus", "notNow"] : ["buyExtra", "notNow"];
  if (b.state === "expired") return ["resubscribe", "notNow"];
  if (b.myPool && b.myPool.status !== "expired" && b.myPool.plan) return ["addToPlan", "notNow"];
  return ["viewPlans", "notNow"];
}

// 서버 billing/plans.ts와 같은 값 (표시용)
export const PLAN_SEC = { band: 20 * 3600, plus: 40 * 3600 } as const;
