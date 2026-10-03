import type { BandBilling } from "@bandapp/types";
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
