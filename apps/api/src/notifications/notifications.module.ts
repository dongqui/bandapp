import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { MembershipsModule } from "../memberships/memberships.module.js";
import { notificationsServiceProvider, NotificationsService } from "./notifications.service.js";
import { pushSenderProvider } from "./push-sender.js";
import { pushTokensServiceProvider, PushTokensService } from "./push-tokens.service.js";

/** 서비스만 — API와 워커가 둘 다 import한다. 컨트롤러는 NotificationsHttpModule */
@Module({
  imports: [DbModule, MembershipsModule],
  providers: [pushSenderProvider, pushTokensServiceProvider, notificationsServiceProvider],
  exports: [NotificationsService, PushTokensService],
})
export class NotificationsModule {}
