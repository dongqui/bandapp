import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { TakesController } from "./takes.controller.js";
import { takesServiceProvider } from "./takes.service.js";

@Module({
  imports: [DbModule, AuthModule, SessionsModule, StorageModule],
  controllers: [TakesController],
  providers: [takesServiceProvider],
  exports: [takesServiceProvider],
})
export class TakesModule {}
