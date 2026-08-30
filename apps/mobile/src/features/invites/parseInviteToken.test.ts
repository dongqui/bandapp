import { describe, expect, it } from "vitest";
import { parseInviteToken } from "./parseInviteToken";

describe("parseInviteToken", () => {
  it("https 초대 URL에서 토큰을 뽑는다", () => {
    expect(parseInviteToken("https://app.example.com/invite/AbC123_-xyz9AbC12345")).toBe(
      "AbC123_-xyz9AbC12345",
    );
  });

  it("커스텀 스킴 딥링크도 처리한다", () => {
    expect(parseInviteToken("bandapp://invite/AbC123_-xyz9AbC12345")).toBe("AbC123_-xyz9AbC12345");
  });

  it("생 토큰은 그대로 반환한다", () => {
    expect(parseInviteToken("AbC123_-xyz9AbC12345")).toBe("AbC123_-xyz9AbC12345");
  });

  it("공백을 다듬고, 토큰이 아니면 null", () => {
    expect(parseInviteToken("  AbC123_-xyz9AbC12345  ")).toBe("AbC123_-xyz9AbC12345");
    expect(parseInviteToken("hello world")).toBeNull();
    expect(parseInviteToken("")).toBeNull();
  });
});
