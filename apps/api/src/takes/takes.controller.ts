import { Body, Controller, Delete, Get, HttpCode, Param, Patch, UseGuards } from "@nestjs/common";
import type { AudioUrl, Take } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { requireInteger, requireUuidParam } from "../common/validation.js";
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

  @Patch("takes/:id")
  update(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<Take> {
    requireUuidParam(id, "id");
    return this.takes.update(id, userId, {
      startMs: requireInteger(body, "startMs", { min: 0 }),
      endMs: requireInteger(body, "endMs", { min: 0 }),
      version: requireInteger(body, "version", { min: 1 }),
    });
  }

  @Delete("takes/:id")
  @HttpCode(204)
  async remove(@CurrentUserId() userId: string, @Param("id") id: string): Promise<void> {
    requireUuidParam(id, "id");
    await this.takes.remove(id, userId);
  }
}
