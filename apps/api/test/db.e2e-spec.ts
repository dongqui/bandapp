import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { userIdentities, users } from "../src/db/schema.js";
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
});
