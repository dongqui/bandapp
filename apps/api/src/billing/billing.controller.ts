import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { BandBilling } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { optionalUuid, requireUuidParam } from "../common/validation.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { BillingSyncService } from "./billing-sync.service.js";
import { BillingService } from "./billing.service.js";

@Controller("bands")
@UseGuards(AuthGuard)
export class BandBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get(":bandId/billing")
  get(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<BandBilling> {
    requireUuidParam(bandId, "bandId");
    return this.billing.bandBilling(bandId, userId);
  }

  @Post(":bandId/billing/link")
  link(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<BandBilling> {
    requireUuidParam(bandId, "bandId");
    return this.billing.link(bandId, userId);
  }

  @Post(":bandId/billing/unlink")
  unlink(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<BandBilling> {
    requireUuidParam(bandId, "bandId");
    return this.billing.unlink(bandId, userId);
  }
}

@Controller("billing")
@UseGuards(AuthGuard)
export class BillingSyncController {
  constructor(
    private readonly sync: BillingSyncService,
    private readonly billing: BillingService,
    private readonly memberships: MembershipsService,
  ) {}

  /** 구매 직후·"Check status"에서 부른다. bandId가 있으면 그 밴드의 멤버여야 하고, 응답으로 그 밴드 billing을 준다 */
  @Post("sync")
  async syncMe(@CurrentUserId() userId: string, @Body() body: unknown): Promise<BandBilling | null> {
    const bandId = optionalUuid(body, "bandId");
    if (bandId) await this.memberships.assertMember(bandId, userId);
    await this.sync.syncUser(userId, { bandId });
    return bandId ? this.billing.bandBilling(bandId, userId) : null;
  }
}
