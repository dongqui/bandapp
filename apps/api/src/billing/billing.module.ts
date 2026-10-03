import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { billingChargeServiceProvider } from "./billing-charge.service.js";

@Module({
  imports: [DbModule],
  providers: [billingChargeServiceProvider],
  exports: [billingChargeServiceProvider],
})
export class BillingModule {}
