import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { Band, BandMember } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireBandPartOrNull, requireString, requireUuidParam } from "../common/validation.js";
import { MembershipsService } from "../memberships/memberships.service.js";
import { BandsService } from "./bands.service.js";

@Controller("bands")
@UseGuards(AuthGuard)
export class BandsController {
  constructor(
    private readonly bandsService: BandsService,
    private readonly memberships: MembershipsService,
  ) {}

  @Post()
  create(@CurrentUserId() userId: string, @Body() body: unknown): Promise<Band> {
    const name = requireString(body, "name").trim();
    if (name.length === 0 || name.length > 50) {
      throw new BadRequestException("name must be 1-50 characters");
    }
    return this.bandsService.create(userId, name);
  }

  @Get()
  list(@CurrentUserId() userId: string): Promise<Band[]> {
    return this.bandsService.listForUser(userId);
  }

  @Get(":bandId/members")
  async members(
    @CurrentUserId() userId: string,
    @Param("bandId") bandId: string,
  ): Promise<BandMember[]> {
    requireUuidParam(bandId, "bandId");
    await this.memberships.assertMember(bandId, userId);
    return this.bandsService.members(bandId);
  }

  @Patch(":bandId/members/me")
  setMyPart(
    @CurrentUserId() userId: string,
    @Param("bandId") bandId: string,
    @Body() body: unknown,
  ): Promise<BandMember> {
    requireUuidParam(bandId, "bandId");
    return this.bandsService.setPart(bandId, userId, requireBandPartOrNull(body, "part"));
  }

  @Delete(":bandId/members/me")
  @HttpCode(204)
  async leave(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<void> {
    requireUuidParam(bandId, "bandId");
    await this.bandsService.leave(bandId, userId);
  }
}
