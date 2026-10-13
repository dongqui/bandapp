import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

export const PUSH_SENDER = Symbol("PUSH_SENDER");

export interface PushMessage {
  title: string;
  body: string;
  /** FCM data는 문자열만 허용. notificationId, bandId, sessionId, type, takeId?, atMs? */
  data: Record<string, string>;
}

/** 발송기. 수신자 1명의 토큰 묶음에 메시지 1개를 보낸다. 더 이상 유효하지 않은 토큰을 돌려주면 호출자가 지운다 */
export interface PushSender {
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}

/** FIREBASE_SERVICE_ACCOUNT_JSON이 없을 때 — 보낼 내용을 로그로만 남긴다. 인박스·배지는 이것과 무관하게 동작한다 */
export class LogPushSender implements PushSender {
  private readonly logger = new Logger(LogPushSender.name);

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    this.logger.log(`push skipped (no FIREBASE_SERVICE_ACCOUNT_JSON) → ${tokens.length} device(s): ${message.title} — ${message.body}`);
    return { invalidTokens: [] };
  }
}

/** 테스트가 가짜를 꽂을 수 있게 messaging에서 쓰는 메서드만 적는다 */
export type MessagingLike = Pick<Messaging, "sendEachForMulticast">;

// 이 코드들을 돌려준 토큰은 다시 보내도 영원히 실패한다 — 행을 지운다
const INVALID_TOKEN_CODES = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);

export class FirebasePushSender implements PushSender {
  private readonly logger = new Logger(FirebasePushSender.name);

  constructor(private readonly messaging: MessagingLike) {}

  /** 서비스 계정 JSON(한 줄) → admin app. Apple 키처럼 환경변수 하나로 끝낸다 */
  static fromServiceAccountJson(json: string): FirebasePushSender {
    let account: unknown;
    try {
      account = JSON.parse(json);
    } catch {
      // 부팅 때 바로 실패시킨다 (SyntaxError 원문에는 값 조각이 섞일 수 있어 감춘다)
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
    const app = initializeApp({ credential: cert(account as Parameters<typeof cert>[0]) });
    return new FirebasePushSender(getMessaging(app));
  }

  async send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }> {
    if (tokens.length === 0) return { invalidTokens: [] };
    const res = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
      apns: { payload: { aps: { sound: "default" } } },
      android: { priority: "high" },
    });
    // 전 토큰이 invalid-argument면 토큰이 아니라 페이로드(크기 초과, 예약된/비문자열 data 키)가 문제다 — 행을 지우지 않는다
    if (res.responses.every((r) => !r.success && r.error?.code === "messaging/invalid-argument")) {
      this.logger.error(`push payload rejected for all ${tokens.length} token(s), keeping them: ${res.responses[0]?.error?.message ?? "invalid-argument"}`);
      return { invalidTokens: [] };
    }
    const invalidTokens: string[] = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code ?? "unknown";
      if (INVALID_TOKEN_CODES.has(code)) invalidTokens.push(tokens[i]!);
      else this.logger.warn(`push to token #${i} failed: ${code}`);
    });
    return { invalidTokens };
  }
}

export const pushSenderProvider: Provider = {
  provide: PUSH_SENDER,
  useFactory: (): PushSender => {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    return json ? FirebasePushSender.fromServiceAccountJson(json) : new LogPushSender();
  },
};
