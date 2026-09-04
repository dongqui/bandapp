import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { bands, comments, recordings, sessions, takes, userIdentities, users } from "../src/db/schema.js";
import { createTestDb, truncateAll } from "./db-util.js";

describe("db schema", () => {
  const db = createTestDb();
  beforeEach(() => truncateAll(db));

  it("user와 identity를 넣고 읽는다", async () => {
    const [user] = await db.insert(users).values({ displayName: "Dongjin" }).returning();
    expect(user?.id).toBeTruthy();
    await db.insert(userIdentities).values({
      userId: user!.id,
      provider: "GOOGLE",
      providerSubject: "g-1",
      email: "a@b.c",
      emailVerified: true,
    });
    const found = await db.query.userIdentities.findFirst({
      where: eq(userIdentities.providerSubject, "g-1"),
    });
    expect(found?.userId).toBe(user!.id);
  });

  it("(provider, provider_subject)는 unique다", async () => {
    const [user] = await db.insert(users).values({}).returning();
    const identity = { userId: user!.id, provider: "GOOGLE" as const, providerSubject: "dup" };
    await db.insert(userIdentities).values(identity);
    await expect(db.insert(userIdentities).values(identity)).rejects.toThrow();
  });

  it("sessions → recordings → takes → comments 체인을 삽입하고 cascade로 지운다", async () => {
    const [user] = await db.insert(users).values({ displayName: "D" }).returning();
    const [band] = await db.insert(bands).values({ name: "B" }).returning();
    const [session] = await db
      .insert(sessions)
      .values({ bandId: band!.id, createdBy: user!.id, title: "Sep 4 Rehearsal", status: "uploading", startedAt: new Date() })
      .returning();
    await db.insert(recordings).values({
      sessionId: session!.id,
      objectKey: `bands/${band!.id}/sessions/${session!.id}/original.m4a`,
      contentType: "audio/mp4",
      sizeBytes: 64_277_703,
      uploadId: "u1",
      partSize: 10 * 1024 * 1024,
      partCount: 7,
      uploadStatus: "pending",
    });
    const [take] = await db
      .insert(takes)
      .values({ sessionId: session!.id, index: 0, name: "Take 1", startMs: 1000, endMs: 61000, type: "PERFORMANCE", confidence: 0.9, objectKey: "k" })
      .returning();
    const [parent] = await db
      .insert(comments)
      .values({ takeId: take!.id, authorId: user!.id, atMs: 5000, text: "hi" })
      .returning();
    await db.insert(comments).values({ takeId: take!.id, authorId: user!.id, parentId: parent!.id, atMs: 5000, text: "reply" });

    await db.delete(sessions).where(eq(sessions.id, session!.id));
    expect(await db.select().from(comments)).toHaveLength(0);
    expect(await db.select().from(takes)).toHaveLength(0);
    expect(await db.select().from(recordings)).toHaveLength(0);
  });
});
