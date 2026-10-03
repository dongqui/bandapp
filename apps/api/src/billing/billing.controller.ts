import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { BandBilling } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireUuidParam } from "../common/validation.js";
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
