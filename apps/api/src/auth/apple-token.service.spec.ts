import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppleTokenService } from "./apple-token.service.js";

async function setAppleEnv(): Promise<void> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.APPLE_TEAM_ID = "TEAM123456";
  process.env.APPLE_KEY_ID = "KEY1234567";
  process.env.APPLE_PRIVATE_KEY = await exportPKCS8(privateKey);
  process.env.APPLE_BUNDLE_ID = "com.taken.app";
}

function mockFetch(res: { ok: boolean; status: number; body?: unknown }) {
  const fn = vi.fn(async () => ({
    ok: res.ok,
    status: res.status,
    json: async () => res.body ?? {},
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** 목 fetch 호출에서 form 파라미터를 뽑는다. */
function formOf(fn: ReturnType<typeof vi.fn>, call = 0): URLSearchParams {
  const init = fn.mock.calls[call]![1] as { body: URLSearchParams };
  return init.body;
}

describe("AppleTokenService", () => {
  beforeEach(setAppleEnv);
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_KEY_ID;
    delete process.env.APPLE_PRIVATE_KEY;
    delete process.env.APPLE_BUNDLE_ID;
  });

  it("client_secret을 ES256으로 서명하고 Apple이 요구하는 클레임을 담는다", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    await new AppleTokenService().exchangeAuthorizationCode("code-1");

    const secret = formOf(fn).get("client_secret")!;
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: "ES256", kid: "KEY1234567" });
    const claims = decodeJwt(secret);
    expect(claims.iss).toBe("TEAM123456");
    expect(claims.sub).toBe("com.taken.app");
    expect(claims.aud).toBe("https://appleid.apple.com");
  });

  it("client_id에 Team ID를 섞지 않는다", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    await new AppleTokenService().exchangeAuthorizationCode("code-1");
    expect(formOf(fn).get("client_id")).toBe("com.taken.app");
  });

  it("authorization code를 refresh token으로 교환한다", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    const result = await new AppleTokenService().exchangeAuthorizationCode("code-1");

    expect(result).toBe("rt-1");
    expect(fn.mock.calls[0]![0]).toBe("https://appleid.apple.com/auth/token");
    const form = formOf(fn);
    expect(form.get("code")).toBe("code-1");
    expect(form.get("grant_type")).toBe("authorization_code");
    // 네이티브 플로우는 인가 요청에 redirect_uri를 주지 않으므로 보내면 안 된다
    expect(form.has("redirect_uri")).toBe(false);
  });

  it("교환이 400이면 null을 돌려준다", async () => {
    mockFetch({ ok: false, status: 400 });
    await expect(new AppleTokenService().exchangeAuthorizationCode("bad")).resolves.toBeNull();
  });

  it("응답에 refresh_token이 없으면 null을 돌려준다", async () => {
    mockFetch({ ok: true, status: 200, body: { access_token: "at-1" } });
    await expect(new AppleTokenService().exchangeAuthorizationCode("code-1")).resolves.toBeNull();
  });

  it("revoke는 refresh_token 힌트로 호출한다", async () => {
    const fn = mockFetch({ ok: true, status: 200 });
    await new AppleTokenService().revokeAll(["rt-1"]);

    expect(fn.mock.calls[0]![0]).toBe("https://appleid.apple.com/auth/revoke");
    const form = formOf(fn);
    expect(form.get("token")).toBe("rt-1");
    expect(form.get("token_type_hint")).toBe("refresh_token");
  });

  it("여러 토큰을 각각 revoke한다", async () => {
    const fn = mockFetch({ ok: true, status: 200 });
    await new AppleTokenService().revokeAll(["rt-1", "rt-2"]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("빈 배열이면 요청하지 않는다", async () => {
    const fn = mockFetch({ ok: true, status: 200 });
    await new AppleTokenService().revokeAll([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fetch가 던져도 revokeAll은 throw하지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(new AppleTokenService().revokeAll(["rt-1"])).resolves.toBeUndefined();
  });

  it("revoke가 400이어도 throw하지 않는다", async () => {
    mockFetch({ ok: false, status: 400 });
    await expect(new AppleTokenService().revokeAll(["rt-1"])).resolves.toBeUndefined();
  });

  it("자격증명이 없으면 아무 요청도 하지 않는다", async () => {
    delete process.env.APPLE_PRIVATE_KEY;
    const fn = mockFetch({ ok: true, status: 200 });
    const service = new AppleTokenService();

    await expect(service.exchangeAuthorizationCode("code-1")).resolves.toBeNull();
    await expect(service.revokeAll(["rt-1"])).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("개행이 \\n으로 이스케이프된 개인키도 읽는다", async () => {
    process.env.APPLE_PRIVATE_KEY = process.env.APPLE_PRIVATE_KEY!.replace(/\n/g, "\\n");
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    await expect(new AppleTokenService().exchangeAuthorizationCode("code-1")).resolves.toBe("rt-1");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("교환 요청에 AbortSignal 타임아웃을 건다", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: { refresh_token: "rt-1" } });
    await new AppleTokenService().exchangeAuthorizationCode("code-1");

    const init = fn.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("revoke 요청에도 AbortSignal 타임아웃을 건다", async () => {
    const fn = mockFetch({ ok: true, status: 200 });
    await new AppleTokenService().revokeAll(["rt-1"]);

    const init = fn.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
