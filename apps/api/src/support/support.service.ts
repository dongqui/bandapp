import type { Provider } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { CreateSupportRequestInput, SupportRequestCreated } from "@bandapp/types";
import { DB } from "../db/db.constants.js";
import type { Db } from "../db/db.module.js";
import { supportRequests, userIdentities, users } from "../db/schema.js";

/** 웹훅 전송만 떼어 놓는다 — 테스트가 fetch 대신 기록기를 꽂는다 */
export type SupportNotifier = (text: string) => Promise<void>;

const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * SUPPORT_WEBHOOK_URL로 Slack/Discord 호환 `{ text }`를 보낸다. 환경변수가 없으면 아무것도 안 한다.
 * 실패해도 던지지 않는다 — 문의는 이미 DB에 있고, 알림은 보조 수단이다.
 */
export const webhookNotifier: SupportNotifier = async (text) => {
  const url = process.env.SUPPORT_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`support webhook responded ${res.status}`);
  } catch (err) {
    console.warn("support webhook failed", err);
  }
};

export class SupportService {
  constructor(
    private readonly db: Db,
    private readonly notify: SupportNotifier,
  ) {}

  async create(userId: string, input: CreateSupportRequestInput): Promise<SupportRequestCreated> {
    const [user] = await this.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    const identity = await this.db.query.userIdentities.findFirst({
      where: eq(userIdentities.userId, userId),
      orderBy: asc(userIdentities.createdAt),
    });
    const email = identity?.email ?? null;
    const [row] = await this.db
      .insert(supportRequests)
      .values({
        userId,
        email,
        topic: input.topic,
        body: input.body,
        appVersion: input.appVersion ?? null,
        device: input.device ?? null,
      })
      .returning({ id: supportRequests.id });
    if (!row) throw new Error("failed to insert support request");
    await this.notify(formatNotification({ ...input, email, displayName: user?.displayName ?? null, userId, id: row.id }));
    return { id: row.id };
  }
}

export function formatNotification(r: CreateSupportRequestInput & {
  id: string;
  userId: string;
  email: string | null;
  displayName: string | null;
}): string {
  const who = `${r.displayName ?? "(no name)"} <${r.email ?? "no email"}> · ${r.userId}`;
  const meta = [r.appVersion && `app ${r.appVersion}`, r.device].filter(Boolean).join(" · ");
  return [`[Take N 문의] ${r.topic}`, who, meta, "", r.body, "", `request ${r.id}`].filter((l) => l !== undefined).join("\n");
}

export const supportServiceProvider: Provider = {
  provide: SupportService,
  useFactory: (db: Db) => new SupportService(db, webhookNotifier),
  inject: [DB],
};
