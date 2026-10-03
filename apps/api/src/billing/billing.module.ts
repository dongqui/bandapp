import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { billingChargeServiceProvider } from "./billing-charge.service.js";
import { BandBillingController } from "./billing.controller.js";
import { billingServiceProvider } from "./billing.service.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule],
  controllers: [BandBillingController],
  providers: [billingChargeServiceProvider, billingServiceProvider],
  exports: [billingChargeServiceProvider, billingServiceProvider],
})
export class BillingModule {}
