import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

const ID = "0c1a4e9e-0f4d-4f3b-9d1e-2f1a1b2c3d4e";

describe("cursor", () => {
  it("왕복 — 마이크로초 문자열을 그대로 보존한다", () => {
    const at = "2026-10-12T03:04:05.678912Z";
    const c = encodeCursor(at, ID);
    expect(c).not.toContain("=");
    expect(decodeCursor(c)).toEqual({ createdAt: at, id: ID });
  });

  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  it.each([
    ["", "빈 문자열"],
    ["nope", "base64 아님"],
    [enc({}), "필드 없음"],
    [enc({ t: "x", id: ID }), "날짜 아님"],
    [enc({ t: "2026-10-12T00:00:00Z", id: "y" }), "uuid 아님"],
  ])("깨진 커서는 400: %s (%s)", (c) => {
    expect(() => decodeCursor(c)).toThrow(BadRequestException);
  });
});
