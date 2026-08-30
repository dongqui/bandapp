import { describe, expect, it } from "vitest";
import { bandGate, gate } from "./authGate";

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

describe("bandGate", () => {
  it("로딩 중이거나 밴드가 있으면 그대로", () => {
    expect(bandGate(null, "(tabs)")).toBeNull();
    expect(bandGate(2, "(tabs)")).toBeNull();
  });
  it("밴드 0개면 온보딩으로 (초대/온보딩/로그인/설정 화면 제외)", () => {
    expect(bandGate(0, "(tabs)")).toEqual({ redirect: "/onboarding" });
    expect(bandGate(0, "onboarding")).toBeNull();
    expect(bandGate(0, "invite")).toBeNull();
  });

  it("밴드 0개여도 설정 화면은 예외 — 로그아웃/탈퇴 경로가 막히지 않게", () => {
    expect(bandGate(0, "settings")).toBeNull();
  });
});
