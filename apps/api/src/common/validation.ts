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

interface Range {
  min?: number;
  max?: number;
}

function field(body: unknown, name: string): unknown {
  return (body as Record<string, unknown> | null | undefined)?.[name];
}

function inRange(value: number, name: string, range: Range): number {
  if (range.min !== undefined && value < range.min) {
    throw new BadRequestException(`${name} must be >= ${range.min}`);
  }
  if (range.max !== undefined && value > range.max) {
    throw new BadRequestException(`${name} must be <= ${range.max}`);
  }
  return value;
}

export function requireNumber(body: unknown, name: string, range: Range = {}): number {
  const value = field(body, name);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequestException(`${name} must be a number`);
  }
  return inRange(value, name, range);
}

export function requireInteger(body: unknown, name: string, range: Range = {}): number {
  const value = field(body, name);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BadRequestException(`${name} must be an integer`);
  }
  return inRange(value, name, range);
}

export function optionalInteger(body: unknown, name: string, range: Range = {}): number | undefined {
  const value = field(body, name);
  if (value === undefined || value === null) return undefined;
  return requireInteger(body, name, range);
}

export function requireOneOf<const T extends readonly string[]>(
  body: unknown,
  name: string,
  values: T,
): T[number] {
  const value = field(body, name);
  if (typeof value !== "string" || !values.includes(value)) {
    throw new BadRequestException(`${name} must be one of ${values.join(", ")}`);
  }
  return value;
}

const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** 오프셋이 붙은 ISO 8601만 받는다 — 서버가 클라이언트의 로컬 날짜를 알아야 title을 만든다 (스펙 결정 14). */
export function requireIsoDate(body: unknown, name: string): string {
  const value = field(body, name);
  if (typeof value !== "string" || !ISO_WITH_OFFSET_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`${name} must be an ISO 8601 date-time with offset`);
  }
  return value;
}
