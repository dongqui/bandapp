import { Inject, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext, Provider } from "@nestjs/common";
import type { Request } from "express";
import { UsersService } from "../users/users.service.js";
import { TokenService } from "./token.service.js";

export interface AuthedRequest extends Request {
  userId?: string;
}

export class AuthGuard implements CanActivate {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException();
    }
    let userId: string;
    try {
      userId = await this.tokens.verifyAccessToken(header.slice("Bearer ".length));
    } catch {
      throw new UnauthorizedException();
    }
    // 탈퇴(soft delete)한 계정의 잔여 access token 차단 (완료 조건 10)
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();
    request.userId = userId;
    return true;
  }
}

export const authGuardProvider: Provider = {
  provide: AuthGuard,
  useFactory: (tokens: TokenService, users: UsersService) => new AuthGuard(tokens, users),
  inject: [TokenService, UsersService],
};
