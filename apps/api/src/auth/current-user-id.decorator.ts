import { UnauthorizedException, createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthedRequest } from "./auth.guard.js";

export const CurrentUserId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<AuthedRequest>();
  if (!request.userId) throw new UnauthorizedException();
  return request.userId;
});
