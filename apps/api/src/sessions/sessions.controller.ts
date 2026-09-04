import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import type { AudioUrl, CreateSessionResult, Session, UploadPartUrl, UploadStatus, UploadedPart } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { optionalInteger, requireInteger, requireIsoDate, requireOneOf, requireString, requireUuidParam } from "../common/validation.js";
import { MAX_UPLOAD_BYTES, SessionsService } from "./sessions.service.js";

const CONTENT_TYPES = ["audio/mp4", "audio/x-m4a"] as const;
const SOURCES = ["recording", "import"] as const;

@Controller("bands")
@UseGuards(AuthGuard)
export class BandSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post(":bandId/sessions")
  create(@CurrentUserId() userId: string, @Param("bandId") bandId: string, @Body() body: unknown): Promise<CreateSessionResult> {
    requireUuidParam(bandId, "bandId");
    return this.sessions.create(bandId, userId, {
      startedAt: requireIsoDate(body, "startedAt"),
      durationMs: optionalInteger(body, "durationMs", { min: 1 }),
      sizeBytes: requireInteger(body, "sizeBytes", { min: 1, max: MAX_UPLOAD_BYTES }),
      contentType: requireOneOf(body, "contentType", CONTENT_TYPES),
      source: requireOneOf(body, "source", SOURCES),
    });
  }

  @Get(":bandId/sessions")
  list(@CurrentUserId() userId: string, @Param("bandId") bandId: string): Promise<Session[]> {
    requireUuidParam(bandId, "bandId");
    return this.sessions.list(bandId, userId);
  }
}

@Controller("sessions")
@UseGuards(AuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get(":id")
  get(@CurrentUserId() userId: string, @Param("id") id: string): Promise<Session> {
    requireUuidParam(id, "id");
    return this.sessions.get(id, userId);
  }

  @Post(":id/upload/parts")
  @HttpCode(200)
  partUrls(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<UploadPartUrl[]> {
    requireUuidParam(id, "id");
    const partNumbers = (body as { partNumbers?: unknown } | null)?.partNumbers;
    if (!Array.isArray(partNumbers)) throw new BadRequestException("partNumbers must be an array");
    return this.sessions.partUrls(id, userId, partNumbers as number[]);
  }

  @Get(":id/upload")
  uploadStatus(@CurrentUserId() userId: string, @Param("id") id: string): Promise<UploadStatus> {
    requireUuidParam(id, "id");
    return this.sessions.uploadStatus(id, userId);
  }

  @Post(":id/upload/complete")
  @HttpCode(200)
  complete(@CurrentUserId() userId: string, @Param("id") id: string, @Body() body: unknown): Promise<Session> {
    requireUuidParam(id, "id");
    const raw = (body as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(raw)) throw new BadRequestException("parts must be an array");
    const parts: UploadedPart[] = raw.map((p) => ({
      partNumber: requireInteger(p, "partNumber", { min: 1 }),
      etag: requireString(p, "etag"),
    }));
    return this.sessions.completeUpload(id, userId, parts);
  }

  @Post(":id/retry")
  @HttpCode(200)
  retry(@CurrentUserId() userId: string, @Param("id") id: string): Promise<Session> {
    requireUuidParam(id, "id");
    return this.sessions.retry(id, userId);
  }

  @Get(":id/audio")
  audio(@CurrentUserId() userId: string, @Param("id") id: string): Promise<AudioUrl> {
    requireUuidParam(id, "id");
    return this.sessions.audioUrl(id, userId);
  }
}
