import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationsModule } from "./notifications.module.js";

@Module({
  imports: [NotificationsModule, AuthModule],
  controllers: [],
})
export class NotificationsHttpModule {}
