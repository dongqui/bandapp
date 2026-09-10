import { describe, expect, it, vi } from "vitest";
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
    expect(takes[0].commentCount).toBe(5); // 답글은 세지 않는다
    expect(takes[2].commentCount).toBe(0);
    const comments = await api.comments.list({ takeId: "s1-t0" });
    const top = comments.filter((c) => c.parentId === null);
    expect(top.map((c) => c.atSec)).toEqual([28, 133, 158, 182, 210]);
    const rushing = top[1]!;
    const replies = comments.filter((c) => c.parentId === rushing.id);
    expect(replies).toHaveLength(5);
    expect(replies.every((r) => r.atSec === rushing.atSec)).toBe(true);
  });

  it("seeded takes and ready sessions carry 128-bucket peaks, and s1's last take is null (placeholder preview)", async () => {
    const api = new MockApiClient();
    const takes = await api.takes.list("s1");
    const first = takes[0]!.peaks!;
    expect(first).toHaveLength(128);
    expect(Math.max(...first)).toBe(255);
    expect(first.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)).toBe(true);
    expect(takes.at(-1)!.peaks).toBeNull();
    const sessions = await api.sessions.list(BAND);
    expect(sessions.find((s) => s.id === "s1")!.peaks).toHaveLength(128);
    expect(sessions.find((s) => s.id === "p1")!.peaks).toBeNull();
  });

  it("comments.create with parentId appends a reply that inherits the parent's atSec and leaves counts alone", async () => {
    const api = new MockApiClient();
    const [parent] = await api.comments.list({ takeId: "s1-t1" });
    const reply = await api.comments.create({ takeId: "s1-t1" }, { parentId: parent!.id, text: "agreed" });
    expect(reply).toMatchObject({ parentId: parent!.id, atSec: parent!.atSec, text: "agreed" });
    const takes = await api.takes.list("s1");
    expect(takes[1].commentCount).toBe(1);
    await expect(api.comments.create({ takeId: "s1-t1" }, { parentId: reply.id, text: "nested" })).rejects.toThrow();
    await expect(api.comments.create({ takeId: "s1-t2" }, { parentId: parent!.id, text: "other take" })).rejects.toThrow();
  });

  it("create returns uploading session, completeUpload transitions to analyzing then ready", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const { session: created } = await api.sessions.create(BAND, {
      startedAt: new Date().toISOString(),
      durationMs: 3_600_000,
      sizeBytes: 1,
      contentType: "audio/mp4",
      source: "recording",
    });
    expect(created.status).toBe("uploading");
    const analyzing = await api.sessions.completeUpload(created.id);
    expect(analyzing.status).toBe("analyzing");
    await wait(50);
    const ready = await api.sessions.get(created.id);
    expect(ready.status).toBe("ready");
    expect(ready.takeCount).toBeGreaterThan(0);
    const takes = await api.takes.list(created.id);
    expect(takes).toHaveLength(ready.takeCount);
  });

  it("uploadStatus returns the partCount computed at create", async () => {
    const api = new MockApiClient();
    const { session: created } = await api.sessions.create(BAND, {
      startedAt: new Date().toISOString(),
      durationMs: 3_600_000,
      sizeBytes: 25 * 1024 * 1024,
      contentType: "audio/mp4",
      source: "recording",
    });
    const status = await api.sessions.uploadStatus(created.id);
    expect(status.partCount).toBe(3);
  });

  it("retryAnalysis moves failed session to analyzing then ready", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const retried = await api.sessions.retryAnalysis("f1");
    expect(retried.status).toBe("analyzing");
    await wait(50);
    expect((await api.sessions.get("f1")).status).toBe("ready");
    const ready = await api.sessions.get("f1");
    expect(ready.peaks).toHaveLength(128);
    const takes = await api.takes.list("f1");
    expect(takes.every((t) => t.peaks?.length === 128)).toBe(true);
  });

  it("comments.create appends, bumps counts, notifies subscribers", async () => {
    const api = new MockApiClient();
    let notified = 0;
    const off = api.subscribe(() => notified++);
    await api.comments.create({ takeId: "s1-t2" }, { atSec: 42, text: "nice" });
    const takes = await api.takes.list("s1");
    expect(takes[2].commentCount).toBe(1);
    const session = await api.sessions.get("s1");
    expect(session.commentCount).toBe(12); // 시드 최상위 9(take) + 2(원본 녹음) + 1
    expect(notified).toBeGreaterThan(0);
    off();
  });

  it("upload calls onCreated with the new session id before finishing", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const seen: string[] = [];
    const source = { sizeBytes: 5, readPart: async () => new Uint8Array(1) };
    const done = await api.sessions.upload(
      BAND,
      { startedAt: new Date().toISOString(), durationMs: 60_000, sizeBytes: 5, contentType: "audio/mp4", source: "recording" },
      source,
      undefined,
      async (id) => { seen.push(id); },
    );
    expect(seen).toEqual([done.id]);
    expect(done.status).toBe("analyzing");
  });

  it("resumeUpload reports progress and completes an uploading session", async () => {
    const api = new MockApiClient({ analysisDelayMs: 10 });
    const { session: created } = await api.sessions.create(BAND, {
      startedAt: new Date().toISOString(), durationMs: 60_000, sizeBytes: 100, contentType: "audio/mp4", source: "recording",
    });
    const progress: number[] = [];
    const source = { sizeBytes: 100, readPart: async () => new Uint8Array(1) };
    const done = await api.sessions.resumeUpload(created.id, source, (p) => progress.push(p.uploadedBytes));
    expect(done.id).toBe(created.id);
    expect(done.status).toBe("analyzing");
    expect(progress.at(-1)).toBe(100);
    await expect(api.sessions.resumeUpload("nope", source)).rejects.toThrow();
  });

  describe("bands.removeMember", () => {
    it("존재하지 않는 밴드면 거부한다", async () => {
      const api = new MockApiClient();
      await expect(api.bands.removeMember("no-such-band", "m2")).rejects.toThrow();
    });

    it("현재 사용자가 owner가 아니면 거부한다 (시드 b2에서는 member)", async () => {
      const api = new MockApiClient();
      await expect(api.bands.removeMember("b2", "m4")).rejects.toThrow();
    });

    it("대상이 멤버가 아니면 거부한다", async () => {
      const api = new MockApiClient();
      const band = await api.bands.create("New Band");
      await expect(api.bands.removeMember(band.id, "no-such-user")).rejects.toThrow();
    });

    it("자기 자신은 내보낼 수 없다", async () => {
      const api = new MockApiClient();
      const band = await api.bands.create("New Band");
      const me = (await api.bands.members(band.id))[0]!;
      await expect(api.bands.removeMember(band.id, me.id)).rejects.toThrow();
    });
  });

  it("comments.list({ sessionId }) returns seeded original-recording comments, and one seeded comment is edited", async () => {
    const api = new MockApiClient();
    const orig = await api.comments.list({ sessionId: "s1" });
    expect(orig.map((c) => [c.takeId, c.sessionId, c.parentId])).toEqual([
      [null, "s1", null],
      [null, "s1", null],
    ]);
    expect(orig[0]!.atSec).toBeLessThan(orig[1]!.atSec);
    const take = await api.comments.list({ takeId: "s1-t0" });
    expect(take.filter((c) => c.updatedAt !== null)).toHaveLength(1);
    expect(take.every((c) => c.takeId === "s1-t0" && c.sessionId === "s1")).toBe(true);
  });

  it("session commentCount includes original-recording comments", async () => {
    const api = new MockApiClient();
    const sessions = await api.sessions.list(BAND);
    const s1 = sessions.find((s) => s.id === "s1")!;
    const takes = await api.takes.list("s1");
    const fromTakes = takes.reduce((a, t) => a + t.commentCount, 0);
    expect(s1.commentCount).toBe(fromTakes + 2);
  });

  it("comments.create on a session attaches an original comment and bumps only the session count", async () => {
    const api = new MockApiClient();
    const before = (await api.sessions.get("s1")).commentCount;
    const c = await api.comments.create({ sessionId: "s1" }, { atSec: 30, text: "orig" });
    expect(c).toMatchObject({ takeId: null, sessionId: "s1", parentId: null, atSec: 30, updatedAt: null });
    expect((await api.sessions.get("s1")).commentCount).toBe(before + 1);
    const takes = await api.takes.list("s1");
    expect(takes[0]!.commentCount).toBe(5);
  });

  it("comments.update changes text only, stamps updatedAt, notifies, and rejects others' comments", async () => {
    const api = new MockApiClient();
    const listener = vi.fn();
    api.subscribe(listener);
    const mine = await api.comments.create({ takeId: "s1-t2" }, { atSec: 42, text: "typo" });
    const updated = await api.comments.update(mine.id, { text: "fixed" });
    expect(updated).toMatchObject({ id: mine.id, text: "fixed", atSec: 42, updatedAt: expect.any(String) });
    expect(listener).toHaveBeenCalledTimes(2);
    const [theirs] = await api.comments.list({ takeId: "s1-t0" });
    await expect(api.comments.update(theirs!.id, { text: "hijack" })).rejects.toThrow();
    await expect(api.comments.update("nope", { text: "x" })).rejects.toThrow();
  });

  it("comments.update rejects whitespace-only text, comments.create rejects an unknown session", async () => {
    const api = new MockApiClient();
    const mine = await api.comments.create({ takeId: "s1-t2" }, { atSec: 42, text: "typo" });
    await expect(api.comments.update(mine.id, { text: "   " })).rejects.toThrow();
    await expect(api.comments.create({ sessionId: "no-such-session" }, { atSec: 1, text: "x" })).rejects.toThrow();
  });

  it("comments.remove deletes the comment and its replies and decrements counts", async () => {
    const api = new MockApiClient();
    const parent = await api.comments.create({ takeId: "s1-t2" }, { atSec: 10, text: "p" });
    await api.comments.create({ takeId: "s1-t2" }, { parentId: parent.id, text: "r" });
    const takeBefore = (await api.takes.list("s1"))[2]!.commentCount;
    const sessionBefore = (await api.sessions.get("s1")).commentCount;
    await api.comments.remove(parent.id);
    expect(await api.comments.list({ takeId: "s1-t2" })).toEqual([]);
    expect((await api.takes.list("s1"))[2]!.commentCount).toBe(takeBefore - 1);
    expect((await api.sessions.get("s1")).commentCount).toBe(sessionBefore - 1);
  });

  it("comments.remove on a reply leaves the parent and counts alone", async () => {
    const api = new MockApiClient();
    const parent = await api.comments.create({ takeId: "s1-t2" }, { atSec: 10, text: "p" });
    const reply = await api.comments.create({ takeId: "s1-t2" }, { parentId: parent.id, text: "r" });
    const takeBefore = (await api.takes.list("s1"))[2]!.commentCount;
    await api.comments.remove(reply.id);
    expect((await api.comments.list({ takeId: "s1-t2" })).map((c) => c.id)).toEqual([parent.id]);
    expect((await api.takes.list("s1"))[2]!.commentCount).toBe(takeBefore);
  });
});
