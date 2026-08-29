import { describe, expect, it } from "vitest";
import { MockApiClient } from "./MockApiClient";

const BAND = "b1";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MockApiClient", () => {
  it("lists seeded sessions newest first with statuses", async () => {
    const api = new MockApiClient();
    const sessions = await api.sessions.list(BAND);
    expect(sessions.map((s) => s.id)).toEqual(["p1", "f1", "s1", "s2", "s3"]);
    expect(sessions[0].status).toBe("analyzing");
    expect(sessions[1].status).toBe("failed");
    expect(sessions[2]).toMatchObject({
      status: "ready",
      name: "Full set run-through",
      takeCount: 7,
    });
  });

  it("lists takes with seeded comment counts", async () => {
    const api = new MockApiClient();
    const takes = await api.takes.list("s1");
    expect(takes).toHaveLength(7);
    expect(takes[0].commentCount).toBe(3);
    expect(takes[2].commentCount).toBe(0);
    const comments = await api.comments.list("s1-t0");
    expect(comments.map((c) => c.atSec)).toEqual([28, 133, 182]);
  });

  it("create returns analyzing session then transitions to ready", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const created = await api.sessions.create(BAND, {
      durationSec: 3600,
      source: "recording",
    });
    expect(created.status).toBe("analyzing");
    await wait(50);
    const ready = await api.sessions.get(created.id);
    expect(ready.status).toBe("ready");
    expect(ready.takeCount).toBeGreaterThan(0);
    const takes = await api.takes.list(created.id);
    expect(takes).toHaveLength(ready.takeCount);
  });

  it("retryAnalysis moves failed session to analyzing then ready", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const retried = await api.sessions.retryAnalysis("f1");
    expect(retried.status).toBe("analyzing");
    await wait(50);
    expect((await api.sessions.get("f1")).status).toBe("ready");
  });

  it("comments.create appends, bumps counts, notifies subscribers", async () => {
    const api = new MockApiClient();
    let notified = 0;
    const off = api.subscribe(() => notified++);
    await api.comments.create("s1-t2", { atSec: 42, text: "nice" });
    const takes = await api.takes.list("s1");
    expect(takes[2].commentCount).toBe(1);
    const session = await api.sessions.get("s1");
    expect(session.commentCount).toBe(8); // 시드 7 + 1
    expect(notified).toBeGreaterThan(0);
    off();
  });
});
