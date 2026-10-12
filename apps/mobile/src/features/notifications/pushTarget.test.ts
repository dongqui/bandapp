import { describe, expect, it } from "vitest";
import { parsePushData, routeFor } from "./pushTarget";

describe("parsePushData", () => {
  it("코멘트 푸시 → take 라우트 + at, 원본은 orig, 세션은 세션 상세", () => {
    const c = parsePushData({ notificationId: "n", bandId: "b", sessionId: "s", type: "comment", takeId: "t", atMs: "133000" })!;
    expect(c).toEqual({ notificationId: "n", bandId: "b", sessionId: "s", takeId: "t", atSec: 133 });
    expect(routeFor(c)).toBe("/session/s/take/t?at=133");
    expect(routeFor(parsePushData({ bandId: "b", sessionId: "s", type: "reply", atMs: "5000" })!)).toBe("/session/s/take/orig?at=5");
    expect(routeFor(parsePushData({ bandId: "b", sessionId: "s", type: "session_ready" })!)).toBe("/session/s");
  });
  it("필수 키가 빠지면 null, atMs가 숫자가 아니면 at 없이", () => {
    expect(parsePushData(undefined)).toBeNull();
    expect(parsePushData({ sessionId: "s", type: "comment" })).toBeNull();
    expect(parsePushData({ bandId: "b", sessionId: "s", type: "comment", atMs: "x" })).toMatchObject({ atSec: null });
  });
});
