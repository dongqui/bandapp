import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

describe("cursor", () => {
  it("왕복", () => {
    const at = new Date("2026-10-12T03:04:05.678Z");
    const c = encodeCursor(at, "0c1a4e9e-0f4d-4f3b-9d1e-2f1a1b2c3d4e");
    expect(c).not.toContain("=");
    expect(decodeCursor(c)).toEqual({ createdAt: at, id: "0c1a4e9e-0f4d-4f3b-9d1e-2f1a1b2c3d4e" });
  });

  it.each(["", "nope", Buffer.from("{}").toString("base64url"), Buffer.from('{"t":"x","id":"y"}').toString("base64url")])("깨진 커서는 400: %s", (c) => {
    expect(() => decodeCursor(c)).toThrow(BadRequestException);
  });
});
