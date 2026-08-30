import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { InvitesController } from "./invites.controller.js";
import { invitesServiceProvider } from "./invites.service.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule],
  controllers: [InvitesController],
  providers: [invitesServiceProvider],
})
export class InvitesModule {}
