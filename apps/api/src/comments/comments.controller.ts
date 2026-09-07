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
  list(@CurrentUserId() userId: string, @Param("id") id: string): Promise<TakeComment[]> {
    requireUuidParam(id, "id");
    return this.comments.list(id, userId);
  }

  @Post(":id/comments")
  create(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    const text = requireString(body, "text");
    const parentId = optionalUuid(body, "parentId");
    // 답글은 부모의 시점을 물려받으므로 atSec을 받지 않는다 (스펙 결정 2)
    if (parentId) return this.comments.create(id, userId, { parentId, text });
    return this.comments.create(id, userId, { atSec: requireNumber(body, "atSec", { min: 0 }), text });
  }
}
