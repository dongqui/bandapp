import { Controller, Delete, Get, HttpCode, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { User } from "@bandapp/types";
import { UsersService } from "../users/users.service.js";
import { AuthGuard } from "./auth.guard.js";
import { CurrentUserId } from "./current-user-id.decorator.js";

@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async me(@CurrentUserId() userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException(); // 탈퇴한 계정의 잔여 access token
    return user;
  }

  @Delete()
  @HttpCode(204)
  async deleteMe(@CurrentUserId() userId: string): Promise<void> {
    await this.users.deleteAccount(userId);
  }
}
