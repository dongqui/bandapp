import { afterEach, describe, expect, it } from "vitest";
import { FirebasePushSender, LogPushSender, pushSenderProvider, type MessagingLike, type PushMessage } from "./push-sender.js";

const message: PushMessage = { title: "t", body: "b", data: { type: "comment" } };

function fakeMessaging(results: Array<{ success: boolean; code?: string }>) {
  const calls: unknown[] = [];
  const messaging = {
    sendEachForMulticast: async (msg: unknown) => {
      calls.push(msg);
      return { successCount: 0, failureCount: 0, responses: results.map((r) => ({ success: r.success, error: r.code ? { code: r.code, message: r.code } : undefined })) };
    },
  } as unknown as MessagingLike;
  return { messaging, calls };
}

describe("FirebasePushSender", () => {
  it("토큰 전체를 한 번에 보내고 unregistered·invalid 토큰만 돌려준다", async () => {
    const { messaging, calls } = fakeMessaging([
      { success: true },
      { success: false, code: "messaging/registration-token-not-registered" },
      { success: false, code: "messaging/internal-error" },
      { success: false, code: "messaging/invalid-argument" },
    ]);
    const res = await new FirebasePushSender(messaging).send(["ok", "gone", "flaky", "bad"], message);
    expect(res.invalidTokens).toEqual(["gone", "bad"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tokens: ["ok", "gone", "flaky", "bad"], notification: { title: "t", body: "b" }, data: { type: "comment" } });
  });

  it("토큰이 없으면 호출하지 않는다", async () => {
    const { messaging, calls } = fakeMessaging([]);
    expect(await new FirebasePushSender(messaging).send([], message)).toEqual({ invalidTokens: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("pushSenderProvider", () => {
  const prev = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  afterEach(() => {
    if (prev === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = prev;
  });

  it("환경변수가 없으면 LogPushSender", async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const factory = (pushSenderProvider as { useFactory: () => unknown }).useFactory;
    expect(factory()).toBeInstanceOf(LogPushSender);
  });

  it("LogPushSender는 보내지 않고 성공으로 끝난다", async () => {
    expect(await new LogPushSender().send(["a", "b"], message)).toEqual({ invalidTokens: [] });
  });
});
