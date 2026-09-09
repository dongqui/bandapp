import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { TakeComment } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { optionalUuid, requireNumber, requireString, requireUuidParam } from "../common/validation.js";
import { CommentsService } from "./comments.service.js";

@Controller("takes")
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get(":id/comments")
  async list(@CurrentUserId() userId: string, @Param("id") id: string): Promise<TakeComment[]> {
    requireUuidParam(id, "id");
    return this.comments.list(await this.comments.scopeForTake(id, userId));
  }

  @Post(":id/comments")
  async create(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    const scope = await this.comments.scopeForTake(id, userId);
    const text = requireString(body, "text");
    const parentId = optionalUuid(body, "parentId");
    // 답글은 부모의 시점을 물려받으므로 atSec을 받지 않는다 (스펙 결정 2)
    if (parentId) return this.comments.create(scope, userId, { parentId, text });
    return this.comments.create(scope, userId, { atSec: requireNumber(body, "atSec", { min: 0 }), text });
  }
}
