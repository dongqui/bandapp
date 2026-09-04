import { BadRequestException } from "@nestjs/common";
import {
  optionalInteger,
  requireInteger,
  requireIsoDate,
  requireNumber,
  requireOneOf,
} from "./validation.js";

describe("requireInteger", () => {
  it("returns the integer within range", () => {
    expect(requireInteger({ n: 5 }, "n", { min: 1, max: 10 })).toBe(5);
  });
  it.each([
    ["missing", {}],
    ["string", { n: "5" }],
    ["float", { n: 5.5 }],
    ["below min", { n: 0 }],
    ["above max", { n: 11 }],
  ])("rejects %s", (_label, body) => {
    expect(() => requireInteger(body, "n", { min: 1, max: 10 })).toThrow(BadRequestException);
  });
});

describe("optionalInteger", () => {
  it("returns undefined when missing or null", () => {
    expect(optionalInteger({}, "n", { min: 0 })).toBeUndefined();
    expect(optionalInteger({ n: null }, "n", { min: 0 })).toBeUndefined();
  });
  it("validates when present", () => {
    expect(optionalInteger({ n: 3 }, "n", { min: 0 })).toBe(3);
    expect(() => optionalInteger({ n: -1 }, "n", { min: 0 })).toThrow(BadRequestException);
  });
});

describe("requireNumber", () => {
  it("accepts floats in range and rejects NaN", () => {
    expect(requireNumber({ x: 1.5 }, "x", { min: 0, max: 2 })).toBe(1.5);
    expect(() => requireNumber({ x: Number.NaN }, "x", { min: 0 })).toThrow(BadRequestException);
    expect(() => requireNumber({ x: 3 }, "x", { min: 0, max: 2 })).toThrow(BadRequestException);
  });
});

describe("requireOneOf", () => {
  it("returns the matching literal", () => {
    expect(requireOneOf({ s: "import" }, "s", ["recording", "import"] as const)).toBe("import");
  });
  it("rejects other values", () => {
    expect(() => requireOneOf({ s: "x" }, "s", ["recording", "import"] as const)).toThrow(
      BadRequestException,
    );
  });
});

describe("requireIsoDate", () => {
  it("accepts ISO 8601 with offset and returns the string", () => {
    expect(requireIsoDate({ d: "2026-09-04T19:03:00+09:00" }, "d")).toBe("2026-09-04T19:03:00+09:00");
    expect(requireIsoDate({ d: "2026-09-04T10:03:00.000Z" }, "d")).toBe("2026-09-04T10:03:00.000Z");
  });
  it.each([
    ["no offset", "2026-09-04T19:03:00"],
    ["date only", "2026-09-04"],
    ["garbage", "yesterday"],
    ["impossible date", "2026-13-40T00:00:00Z"],
  ])("rejects %s", (_label, d) => {
    expect(() => requireIsoDate({ d }, "d")).toThrow(BadRequestException);
  });
});
