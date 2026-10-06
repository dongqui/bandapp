export type PoolPlan = "band" | "plus";
export type BandBillingState = "free" | "linked" | "expired";

/** `GET /bands/:id/billing` 응답. 디자인 B01의 state 분기: free/linked/expired */
export interface BandBilling {
  state: BandBillingState;
  plan: PoolPlan | null;
  periodEnd: string | null; // ISO
  willRenew: boolean;
  store: "app_store" | "play_store" | null;
  availableSec: number;
  monthlyTotalSec: number;
  monthlyLeftSec: number;
  monthlyUsedSec: number;
  extraSec: number;
  freeLeftSec: number;
  owner: { id: string; displayName: string };
  isOwner: boolean;
  linkedBandCount: number;
  canBuyExtra: boolean;
  /** 요청자 본인의 풀. 풀 행이 없으면 null. 오너가 아닌 밴드에서도 채운다 — Me 화면의 "내 구독" 카드 재료 */
  myPool: {
    plan: PoolPlan | null;
    status: "active" | "grace" | "expired";
    periodEnd: string | null; // ISO
    willRenew: boolean;
    store: "app_store" | "play_store" | null;
    monthlyLeftSec: number;
    bands: Array<{ id: string; name: string; memberCount: number; linked: boolean }>;
  } | null;
}

export type BillingErrorCode = "billing_owner_only" | "billing_no_active_pool" | "billing_band_linked_elsewhere";
