import { Module } from "@nestjs/common";
import { AnalysisModule } from "../analysis/analysis.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { BandSessionsController, SessionsController } from "./sessions.controller.js";
import { sessionsServiceProvider } from "./sessions.service.js";

@Module({
  imports: [DbModule, AuthModule, MembershipsModule, StorageModule, AnalysisModule],
  controllers: [BandSessionsController, SessionsController],
  providers: [sessionsServiceProvider],
  exports: [sessionsServiceProvider],
})
export class SessionsModule {}
