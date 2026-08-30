import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { BandsController } from "./bands.controller.js";
import { bandsServiceProvider } from "./bands.service.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule],
  controllers: [BandsController],
  providers: [bandsServiceProvider],
})
export class BandsModule {}
