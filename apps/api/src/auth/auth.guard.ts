import { Inject, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext, Provider } from "@nestjs/common";
import type { Request } from "express";
import { TokenService } from "./token.service.js";

export interface AuthedRequest extends Request {
  userId?: string;
}

export class AuthGuard implements CanActivate {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new UnauthorizedException();
    }
    try {
      request.userId = await this.tokens.verifyAccessToken(header.slice("Bearer ".length));
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}

export const authGuardProvider: Provider = {
  provide: AuthGuard,
  useFactory: (tokens: TokenService) => new AuthGuard(tokens),
  inject: [TokenService],
};
