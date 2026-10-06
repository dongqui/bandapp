import { describe, expect, it, vi } from "vitest";
import type { AuthTokens } from "@bandapp/types";
import type { TokenStorage } from "../client";
import { HttpApiClient } from "./HttpApiClient";

function tokens(): TokenStorage {
  const state: Partial<AuthTokens> = { accessToken: "a1", refreshToken: "r1" };
  return {
    getAccessToken: async () => state.accessToken ?? null,
    getRefreshToken: async () => state.refreshToken ?? null,
    setTokens: async (t) => Object.assign(state, t),
    clear: async () => {
      delete state.accessToken;
      delete state.refreshToken;
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const user = { id: "u1", displayName: "D", profileImageUrl: null, email: "d@test.dev" };

describe("HttpApiClient 프로필·문의", () => {
  it("updateMe는 PATCH /me로 보내고 구독자에게 통지한다", async () => {
    const fetchFn = vi.fn(async () => json(200, { ...user, displayName: "New" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens: tokens(), fetchFn });
    const listener = vi.fn();
    client.subscribe(listener);
    const res = await client.auth.updateMe({ displayName: "New" });
    expect(res.displayName).toBe("New");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/me");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ displayName: "New" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setPhoto는 multipart FormData를 content-type 없이(런타임이 boundary를 붙이게) PUT한다", async () => {
    const fetchFn = vi.fn(async () => json(200, { ...user, profileImageUrl: "https://r2/x" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens: tokens(), fetchFn });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const res = await client.auth.setPhoto(blob);
    expect(res.profileImageUrl).toBe("https://r2/x");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/me/photo");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("photo")).toBeInstanceOf(Blob);
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer a1");
  });

  it("removePhoto는 DELETE /me/photo 후 통지한다", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens: tokens(), fetchFn });
    const listener = vi.fn();
    client.subscribe(listener);
    await client.auth.removePhoto();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/me/photo");
    expect(init.method).toBe("DELETE");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("support.send는 POST /support/requests", async () => {
    const fetchFn = vi.fn(async () => json(201, { id: "s1" }));
    const client = new HttpApiClient({ baseUrl: "https://api.test", tokens: tokens(), fetchFn });
    const res = await client.support.send({ topic: "idea", body: "Dark mode", appVersion: "1.0.0", device: "ios 18" });
    expect(res).toEqual({ id: "s1" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/support/requests");
    expect(JSON.parse(init.body as string)).toEqual({ topic: "idea", body: "Dark mode", appVersion: "1.0.0", device: "ios 18" });
  });
});
