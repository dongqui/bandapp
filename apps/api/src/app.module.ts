import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { UsersModule } from "./users/users.module.js";
import { BandsModule } from "./bands/bands.module.js";
import { MembershipsModule } from "./memberships/memberships.module.js";
import { InvitesModule } from "./invites/invites.module.js";
import { SessionsModule } from "./sessions/sessions.module.js";
import { RecordingsModule } from "./recordings/recordings.module.js";
import { TakesModule } from "./takes/takes.module.js";
import { CommentsModule } from "./comments/comments.module.js";
import { StorageModule } from "./storage/storage.module.js";
import { AnalysisModule } from "./analysis/analysis.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { DbModule } from "./db/db.module.js";

@Module({
  imports: [
    HealthModule,
    AuthModule,
    UsersModule,
    BandsModule,
    MembershipsModule,
    InvitesModule,
    SessionsModule,
    RecordingsModule,
    TakesModule,
    CommentsModule,
    StorageModule,
    AnalysisModule,
    NotificationsModule,
    DbModule,
  ],
})
export class AppModule {}
