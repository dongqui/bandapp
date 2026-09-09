import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import type { CreateCommentInput, TakeComment } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { optionalUuid, requireNumber, requireString, requireUuidParam } from "../common/validation.js";
import { CommentsService } from "./comments.service.js";

/** 답글은 부모의 시점을 물려받으므로 atSec을 받지 않는다 (스레드 스펙 결정 2) */
function parseCreate(body: unknown): CreateCommentInput {
  const text = requireString(body, "text");
  const parentId = optionalUuid(body, "parentId");
  if (parentId) return { parentId, text };
  return { atSec: requireNumber(body, "atSec", { min: 0 }), text };
}

@Controller()
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get("takes/:id/comments")
  async listForTake(@CurrentUserId() userId: string, @Param("id") id: string): Promise<TakeComment[]> {
    requireUuidParam(id, "id");
    return this.comments.list(await this.comments.scopeForTake(id, userId));
  }

  @Post("takes/:id/comments")
  async createForTake(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    const scope = await this.comments.scopeForTake(id, userId);
    return this.comments.create(scope, userId, parseCreate(body));
  }

  /** 원본 녹음 코멘트 (2026-09-09 스펙) */
  @Get("sessions/:id/comments")
  async listForSession(@CurrentUserId() userId: string, @Param("id") id: string): Promise<TakeComment[]> {
    requireUuidParam(id, "id");
    return this.comments.list(await this.comments.scopeForSession(id, userId));
  }

  @Post("sessions/:id/comments")
  async createForSession(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    const scope = await this.comments.scopeForSession(id, userId);
    return this.comments.create(scope, userId, parseCreate(body));
  }

  @Patch("comments/:id")
  update(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<TakeComment> {
    requireUuidParam(id, "id");
    return this.comments.update(id, userId, { text: requireString(body, "text") });
  }

  @Delete("comments/:id")
  @HttpCode(204)
  async remove(@CurrentUserId() userId: string, @Param("id") id: string): Promise<void> {
    requireUuidParam(id, "id");
    await this.comments.remove(id, userId);
  }
}
