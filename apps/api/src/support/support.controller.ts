import { BadRequestException, Body, Controller, Post, UseGuards } from "@nestjs/common";
import { SUPPORT_BODY_MAX, SUPPORT_TOPICS, type SupportRequestCreated } from "@bandapp/types";
import { AuthGuard } from "../auth/auth.guard.js";
import { CurrentUserId } from "../auth/current-user-id.decorator.js";
import { optionalString, requireOneOf, requireString } from "../common/validation.js";
import { SupportService } from "./support.service.js";

const META_MAX = 200;

function optionalMeta(body: unknown, name: string): string | undefined {
  const value = optionalString(body, name)?.trim();
  if (!value) return undefined;
  return value.slice(0, META_MAX); // 클라이언트가 주는 부가 정보라 잘라서 받는다
}

@Controller("support")
@UseGuards(AuthGuard)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post("requests")
  create(@CurrentUserId() userId: string, @Body() body: unknown): Promise<SupportRequestCreated> {
    const topic = requireOneOf(body, "topic", SUPPORT_TOPICS);
    const text = requireString(body, "body").trim();
    if (text.length === 0 || text.length > SUPPORT_BODY_MAX) {
      throw new BadRequestException(`body must be 1-${SUPPORT_BODY_MAX} characters`);
    }
    return this.support.create(userId, {
      topic,
      body: text,
      appVersion: optionalMeta(body, "appVersion"),
      device: optionalMeta(body, "device"),
    });
  }
}
