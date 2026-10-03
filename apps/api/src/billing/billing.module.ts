import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { billingChargeServiceProvider } from "./billing-charge.service.js";
import { billingSyncServiceProvider } from "./billing-sync.service.js";
import { BandBillingController, BillingSyncController } from "./billing.controller.js";
import { billingServiceProvider } from "./billing.service.js";
import { RevenueCatWebhookController } from "./revenuecat-webhook.controller.js";
import { revenueCatClientProvider } from "./revenuecat.client.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule],
  controllers: [BandBillingController, BillingSyncController, RevenueCatWebhookController],
  providers: [billingChargeServiceProvider, billingServiceProvider, revenueCatClientProvider, billingSyncServiceProvider],
  exports: [billingChargeServiceProvider, billingServiceProvider],
})
export class BillingModule {}
