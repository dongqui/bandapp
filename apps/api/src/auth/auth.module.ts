import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { DbModule } from "../db/db.module.js";
import { UsersModule } from "../users/users.module.js";
import { appleAuthServiceProvider } from "./apple-auth.service.js";
import { authSessionsServiceProvider } from "./auth-sessions.service.js";
import { AuthController } from "./auth.controller.js";
import { authServiceProvider } from "./auth.service.js";
import { AuthGuard, authGuardProvider } from "./auth.guard.js";
import { googleAuthServiceProvider } from "./google-auth.service.js";
import { MeController } from "./me.controller.js";
import { tokenServiceProvider, TokenService } from "./token.service.js";

@Module({
  imports: [
    DbModule,
    UsersModule,
    // 로그인 API rate limit (기획서 20장). e2e에서는 AUTH_THROTTLE_LIMIT로 완화한다.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 20) }],
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [
    tokenServiceProvider,
    googleAuthServiceProvider,
    appleAuthServiceProvider,
    authSessionsServiceProvider,
    authServiceProvider,
    authGuardProvider,
  ],
  exports: [TokenService, AuthGuard],
})
export class AuthModule {}
