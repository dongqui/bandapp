import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { membershipsServiceProvider, MembershipsService } from "./memberships.service.js";

@Module({
  imports: [DbModule],
  providers: [membershipsServiceProvider],
  exports: [MembershipsService],
})
export class MembershipsModule {}
