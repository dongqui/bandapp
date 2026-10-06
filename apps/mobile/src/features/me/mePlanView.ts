import type { BandBilling, PoolPlan } from "@bandapp/types";

/**
 * Me 화면 SUBSCRIPTION 카드의 상태 (디자인 mePlanName/Price/Meta/Cta). "내 구독" 기준이라
 * 현재 밴드의 연결 상태가 아니라 요청자의 풀(myPool)로 판단한다 (2026-10-06 스펙).
 */
export type MePlanModel =
  | {
      kind: "active";
      plan: PoolPlan;
      willRenew: boolean;
      periodEnd: string | null;
      store: "app_store" | "play_store" | null;
      /** 내 플랜에 연결된 밴드 수 — "Bands on your plan" 행 */
      linkedCount: number;
      /** "Change plan"이 여는 플랜 화면의 기본 선택: 지금 플랜의 반대쪽 */
      nextSel: PoolPlan;
    }
  | { kind: "expired"; plan: PoolPlan; periodEnd: string | null }
  /** 내 풀은 없고 현재 밴드는 남의 플랜에 연결됨 */
  | { kind: "othersPlan"; ownerName: string }
  | { kind: "free" };

export function mePlanModel(b: BandBilling): MePlanModel {
  const pool = b.myPool;
  if (pool?.plan && pool.status !== "expired") {
    return {
      kind: "active",
      plan: pool.plan,
      willRenew: pool.willRenew,
      periodEnd: pool.periodEnd,
      store: pool.store,
      linkedCount: pool.bands.filter((x) => x.linked).length,
      nextSel: pool.plan === "band" ? "plus" : "band",
    };
  }
  if (pool?.plan) return { kind: "expired", plan: pool.plan, periodEnd: pool.periodEnd };
  if (b.state === "linked" && !b.isOwner) return { kind: "othersPlan", ownerName: b.owner.displayName };
  return { kind: "free" };
}
