import { Body, Controller, Headers, HttpCode, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { billingEvents, users } from "../db/schema.js";
import { BillingSyncService } from "./billing-sync.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RcWebhookBody {
  event?: {
    id?: string;
    type?: string;
    app_user_id?: string;
    subscriber_attributes?: Record<string, { value: string }>;
    // TRANSFER 이벤트: 구독이 옮겨 간 양쪽 사용자. app_user_id가 없을 수 있다
    transferred_from?: string[];
    transferred_to?: string[];
  };
}

/**
 * RevenueCat 웹훅. AuthGuard 없이 공유 시크릿만 본다. 이벤트 본문은 중복 판별과 기록용이고,
 * 실제 상태는 REST로 다시 읽는다 — 순서가 뒤바뀐 이벤트에도 결과가 같다 (스펙 "웹훅").
 */
@Controller("webhooks")
export class RevenueCatWebhookController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BillingSyncService) private readonly sync: BillingSyncService,
  ) {}

  @Post("revenuecat")
  @HttpCode(200)
  async handle(@Headers("authorization") authorization: string | undefined, @Body() body: RcWebhookBody): Promise<Record<string, never>> {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (!secret || authorization !== `Bearer ${secret}`) throw new UnauthorizedException();
    const ev = body.event;
    if (!ev?.id || !ev.type) return {};
    const transferIds = [...(ev.transferred_from ?? []), ...(ev.transferred_to ?? [])].filter((x): x is string => typeof x === "string");
    const recordUserId = ev.app_user_id ?? transferIds[0];
    if (!recordUserId) return {};
    const inserted = await this.db
      .insert(billingEvents)
      .values({ id: ev.id, type: ev.type, appUserId: recordUserId, payload: ev })
      .onConflictDoNothing()
      .returning({ id: billingEvents.id });
    if (inserted.length === 0) return {}; // 중복 전달
    try {
      // 익명 ID($RCAnonymousID:...)나 우리 users에 없는 id는 무시 — 로그인 전 구매는 logIn 뒤 sync로 들어온다
      if (ev.app_user_id && (await this.isKnownUser(ev.app_user_id))) {
        await this.sync.syncUser(ev.app_user_id, { attributeBandId: ev.subscriber_attributes?.band_id?.value });
      }
      // TRANSFER: 구독을 잃은 쪽(풀 만료)과 얻은 쪽 모두 다시 읽는다 — 안 하면 잃은 쪽 풀이 active로 남는다
      for (const id of new Set(transferIds)) {
        if (id === ev.app_user_id || !(await this.isKnownUser(id))) continue;
        await this.sync.syncUser(id);
      }
    } catch (err) {
      // 동기화가 실패하면 중복 판별 행을 지우고 500으로 돌려보낸다 — 그래야 RevenueCat의 재시도가
      // 중복으로 오인돼 200으로 끝나지 않고(갱신·만료 누락) 다시 처리된다.
      await this.db.delete(billingEvents).where(eq(billingEvents.id, ev.id));
      throw err;
    }
    return {};
  }

  private async isKnownUser(id: string): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, id));
    return user !== undefined;
  }
}
