import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { AuthTokens, LoginResponse } from "@bandapp/types";
import { optionalString, requireString } from "../common/validation.js";
import { AuthService } from "./auth.service.js";

@Controller("auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("google")
  google(@Body() body: unknown): Promise<LoginResponse> {
    return this.auth.loginWithGoogle(requireString(body, "idToken"));
  }

  @Post("apple")
  apple(@Body() body: unknown): Promise<LoginResponse> {
    return this.auth.loginWithApple(
      requireString(body, "idToken"),
      optionalString(body, "displayName"),
    );
  }

  @Post("refresh")
  refresh(@Body() body: unknown): Promise<AuthTokens> {
    return this.auth.refresh(requireString(body, "refreshToken"));
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Body() body: unknown): Promise<void> {
    await this.auth.logout(requireString(body, "refreshToken"));
  }
}
