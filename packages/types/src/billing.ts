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
  myPool: {
    plan: PoolPlan | null;
    status: "active" | "grace" | "expired";
    monthlyLeftSec: number;
    bands: Array<{ id: string; name: string; memberCount: number; linked: boolean }>;
  } | null;
}

export type BillingErrorCode = "billing_owner_only" | "billing_no_active_pool" | "billing_band_linked_elsewhere";
