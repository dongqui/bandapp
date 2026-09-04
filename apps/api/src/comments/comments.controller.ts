import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { TakeComment } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireNumber, requireString, requireUuidParam } from "../common/validation.js";
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
    return this.comments.create(id, userId, {
      atSec: requireNumber(body, "atSec", { min: 0 }),
      text: requireString(body, "text"),
    });
  }
}
