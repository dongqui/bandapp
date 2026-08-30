import { describe, expect, it, vi } from "vitest";
import type { AuthTokens } from "@bandapp/types";
import type { TokenStorage } from "../client";
import { ApiError, HttpApiClient } from "./HttpApiClient";

function memoryTokens(initial?: Partial<AuthTokens>): TokenStorage & { state: Partial<AuthTokens> } {
  const state: Partial<AuthTokens> = { ...initial };
  return {
    state,
    getAccessToken: async () => state.accessToken ?? null,
    getRefreshToken: async () => state.refreshToken ?? null,
    setTokens: async (tokens) => {
      state.accessToken = tokens.accessToken;
      state.refreshToken = tokens.refreshToken;
    },
    clear: async () => {
      delete state.accessToken;
      delete state.refreshToken;
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("HttpApiClient", () => {
  it("로그인 성공 시 토큰을 저장한다", async () => {
    const tokens = memoryTokens();
    const fetchFn = vi.fn(async () =>
      json(201, { accessToken: "a1", refreshToken: "r1", user: { id: "u1", displayName: "D", profileImageUrl: null }, isNewUser: true }),
    );
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const res = await client.auth.loginWithGoogle("id-token");
    expect(res.isNewUser).toBe(true);
    expect(tokens.state).toEqual({ accessToken: "a1", refreshToken: "r1" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.test/auth/google",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("401이면 refresh 후 원요청을 재시도한다 (기획서 8장)", async () => {
    const tokens = memoryTokens({ accessToken: "stale", refreshToken: "r1" });
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/auth/refresh")) return json(201, { accessToken: "a2", refreshToken: "r2" });
      const authed = (fetchFn.mock.calls.length ?? 0) > 2; // 세 번째 호출(재시도)부터 성공
      return authed ? json(200, { id: "u1", displayName: "D", profileImageUrl: null }) : json(401, { message: "unauthorized" });
    });
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    const me = await client.auth.me();
    expect(me.id).toBe("u1");
    expect(tokens.state).toEqual({ accessToken: "a2", refreshToken: "r2" });
    expect(fetchFn).toHaveBeenCalledTimes(3); // 원요청 → refresh → 재시도
  });

  it("동시 401은 refresh를 한 번만 수행한다", async () => {
    const tokens = memoryTokens({ accessToken: "stale", refreshToken: "r1" });
    let refreshCalls = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/auth/refresh")) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return json(201, { accessToken: "a2", refreshToken: "r2" });
      }
      const token = (init?.headers as Record<string, string>)?.authorization;
      return token === "Bearer a2"
        ? json(200, [])
        : json(401, { message: "unauthorized" });
    });
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await Promise.all([client.bands.list(), client.bands.list(), client.bands.list()]);
    expect(refreshCalls).toBe(1);
  });

  it("refresh 실패면 토큰을 지우고 onSessionExpired를 호출한다", async () => {
    const tokens = memoryTokens({ accessToken: "stale", refreshToken: "dead" });
    const onSessionExpired = vi.fn();
    const fetchFn = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/auth/refresh") ? json(401, {}) : json(401, {}),
    );
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn, onSessionExpired });
    await expect(client.auth.me()).rejects.toBeInstanceOf(ApiError);
    expect(tokens.state).toEqual({});
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it("refresh 토큰이 없으면 401 응답에서도 저장된 access token을 지운다", async () => {
    const tokens = memoryTokens({ accessToken: "stale" }); // refreshToken 없음 (부분 손상된 저장소)
    const onSessionExpired = vi.fn();
    const fetchFn = vi.fn(async () => json(401, { message: "unauthorized" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn, onSessionExpired });
    await expect(client.auth.me()).rejects.toBeInstanceOf(ApiError);
    expect(tokens.state).toEqual({});
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it("서버 오류 메시지를 ApiError로 전달한다", async () => {
    const tokens = memoryTokens();
    const fetchFn = vi.fn(async () => json(409, { message: "관리자로 있는 팀이 있어요." }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await expect(client.auth.deleteAccount()).rejects.toMatchObject({
      status: 409,
      message: "관리자로 있는 팀이 있어요.",
    });
  });

  it("preview는 인증 헤더 없이 호출된다", async () => {
    const tokens = memoryTokens({ accessToken: "a1", refreshToken: "r1" });
    const fetchFn = vi.fn(async () =>
      json(200, { band: { name: "FRIDAY NIGHT", memberCount: 4 }, invitedBy: { displayName: "Minsoo" }, expiresAt: "2026-09-06T00:00:00Z" }),
    );
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens, fetchFn });
    await client.invites.preview("tok123");
    const headers = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers?.authorization).toBeUndefined();
  });
});
