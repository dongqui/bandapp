/**
 * 플랜표 — 결제의 유일한 기준 (2026-10-03 스펙). 가격은 앱이 스토어에서 받는다.
 * 플랜을 늘리려면 여기와 스토어 콘솔(같은 구독 그룹)만 바꾼다.
 */
export const FREE_SEC = 3 * 3600;
export const EXTRA_SEC = 3 * 3600;
export const PLANS = {
  band: { monthlySec: 20 * 3600 },
  plus: { monthlySec: 40 * 3600 },
} as const;
export type PoolPlan = keyof typeof PLANS;

/** 스토어 상품 ID → 플랜. iOS·Android 모두 같은 ID를 쓴다 */
export const SUBSCRIPTION_PRODUCTS: Record<string, PoolPlan> = {
  "rehearsal.band.monthly": "band",
  "rehearsal.plus.monthly": "plus",
};
export const EXTRA_PRODUCT_IDS: readonly string[] = ["rehearsal.extra.3h"];
