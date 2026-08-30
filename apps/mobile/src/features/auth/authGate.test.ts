import { describe, expect, it } from "vitest";
import { gate } from "./authGate";

describe("gate", () => {
  it("복원 중에는 리다이렉트하지 않는다 (스플래시 유지)", () => {
    expect(gate("restoring", undefined)).toBeNull();
    expect(gate("restoring", "login")).toBeNull();
  });

  it("guest는 공개 라우트(login, invite) 외에는 /login으로", () => {
    expect(gate("guest", "(tabs)")).toEqual({ redirect: "/login" });
    expect(gate("guest", undefined)).toEqual({ redirect: "/login" });
    expect(gate("guest", "login")).toBeNull();
    expect(gate("guest", "invite")).toBeNull(); // 초대 preview는 비로그인 열람 가능 (기획서 13장)
  });

  it("로그인 상태로 /login에 있으면 홈으로", () => {
    expect(gate("authenticated", "login")).toEqual({ redirect: "/" });
    expect(gate("authenticated", "(tabs)")).toBeNull();
    expect(gate("authenticated", "invite")).toBeNull();
  });
});
