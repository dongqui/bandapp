import { BadRequestException } from "@nestjs/common";
import type { BandPart } from "@bandapp/types";

export function requireString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestException(`${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(body: unknown, field: string): string | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuidParam(value: string, name: string): string {
  if (!UUID_RE.test(value)) throw new BadRequestException(`${name} must be a UUID`);
  return value;
}

const BAND_PARTS = ["vocal", "guitar", "bass", "drums", "keyboard", "other"] as const;

/**
 * null을 허용한다 — 파트 미설정이 정상 상태이고, 해제 전용 엔드포인트 대신 같은 PATCH로 받는다
 * (스펙 결정 4). 필드가 아예 없으면 400 — 의도한 해제와 실수를 구분한다.
 */
export function requireBandPartOrNull(body: unknown, field: string): BandPart | null {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === null) return null;
  if (typeof value !== "string" || !(BAND_PARTS as readonly string[]).includes(value)) {
    throw new BadRequestException(`${field} must be one of ${BAND_PARTS.join(", ")} or null`);
  }
  return value as BandPart;
}
