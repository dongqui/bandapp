import type { Provider } from "@nestjs/common";

/** RevenueCat REST v1 `GET /v1/subscribers/{app_user_id}` 응답 중 쓰는 부분만 */
export interface RcSubscriber {
  subscriptions: Record<
    string,
    {
      expires_date: string | null;
      purchase_date: string;
      store: string;
      unsubscribe_detected_at: string | null;
      billing_issues_detected_at: string | null;
      period_type: string;
    }
  >;
  non_subscriptions: Record<string, Array<{ id: string; purchase_date: string; store: string }>>;
  subscriber_attributes?: Record<string, { value: string }>;
}

export class RevenueCatClient {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async getSubscriber(appUserId: string): Promise<RcSubscriber> {
    // 키는 호출 시점에 읽는다 — 없으면 결제 기능만 죽고 서버는 뜬다 (기존 env 패턴)
    const key = process.env.REVENUECAT_API_KEY;
    if (!key) throw new Error("REVENUECAT_API_KEY is not set");
    const res = await this.fetchFn(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`revenuecat ${res.status}`);
    const body = (await res.json()) as { subscriber: RcSubscriber };
    return body.subscriber;
  }
}

export const revenueCatClientProvider: Provider = { provide: RevenueCatClient, useFactory: () => new RevenueCatClient() };
