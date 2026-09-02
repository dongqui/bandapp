import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { BandInvite, InvitePreview, JoinInviteResult } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireUuidParam } from "../common/validation.js";
import { inviteError } from "./invite-errors.js";
import { InvitesService } from "./invites.service.js";

const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function requireInviteToken(token: string): string {
  // 형식이 아예 다르면 조회 없이 404 (없는 토큰과 같은 응답)
  if (!INVITE_TOKEN_RE.test(token)) throw new NotFoundException(inviteError("invite_not_found"));
  return token;
}

@Controller()
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post("bands/:bandId/invites")
  @UseGuards(AuthGuard)
  create(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<BandInvite> {
    return this.invites.create(requireUuidParam(bandId, "bandId"), userId);
  }

  /** 비로그인에도 최소 정보만 공개 (기획서 12장) */
  @Get("invites/:token")
  preview(@Param("token") token: string): Promise<InvitePreview> {
    return this.invites.preview(requireInviteToken(token));
  }

  @Post("invites/:token/join")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  join(@CurrentUserId() userId: string, @Param("token") token: string): Promise<JoinInviteResult> {
    return this.invites.join(requireInviteToken(token), userId);
  }

  @Delete("bands/:bandId/invites/:inviteId")
  @HttpCode(204)
  @UseGuards(AuthGuard)
  revoke(
    @CurrentUserId() userId: string,
    @Param("bandId") bandId: string,
    @Param("inviteId") inviteId: string,
  ): Promise<void> {
    return this.invites.revoke(
      requireUuidParam(bandId, "bandId"),
      requireUuidParam(inviteId, "inviteId"),
      userId,
    );
  }
}
