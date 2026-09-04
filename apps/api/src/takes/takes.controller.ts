import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import type { AudioUrl, Take } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireUuidParam } from "../common/validation.js";
import { TakesService } from "./takes.service.js";

@Controller()
@UseGuards(AuthGuard)
export class TakesController {
  constructor(private readonly takes: TakesService) {}

  @Get("sessions/:id/takes")
  list(@CurrentUserId() userId: string, @Param("id") id: string): Promise<Take[]> {
    requireUuidParam(id, "id");
    return this.takes.list(id, userId);
  }

  @Get("takes/:id/audio")
  audio(@CurrentUserId() userId: string, @Param("id") id: string): Promise<AudioUrl> {
    requireUuidParam(id, "id");
    return this.takes.audioUrl(id, userId);
  }
}
