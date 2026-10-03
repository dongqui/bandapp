import { Body, Controller, Headers, HttpCode, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { billingEvents, users } from "../db/schema.js";
import { BillingSyncService } from "./billing-sync.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RcWebhookBody {
  event?: { id?: string; type?: string; app_user_id?: string; subscriber_attributes?: Record<string, { value: string }> };
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
    if (!ev?.id || !ev.type || !ev.app_user_id) return {};
    const inserted = await this.db
      .insert(billingEvents)
      .values({ id: ev.id, type: ev.type, appUserId: ev.app_user_id, payload: ev })
      .onConflictDoNothing()
      .returning({ id: billingEvents.id });
    if (inserted.length === 0) return {}; // 중복 전달
    // 익명 ID($RCAnonymousID:...)나 우리 users에 없는 id는 무시 — 로그인 전 구매는 logIn 뒤 sync로 들어온다
    if (!UUID_RE.test(ev.app_user_id)) return {};
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, ev.app_user_id));
    if (!user) return {};
    await this.sync.syncUser(ev.app_user_id, { attributeBandId: ev.subscriber_attributes?.band_id?.value });
    return {};
  }
}
