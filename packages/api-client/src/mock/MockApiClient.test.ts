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

  describe("bands.removeMember", () => {
    it("존재하지 않는 밴드면 거부한다", async () => {
      const api = new MockApiClient();
      await expect(api.bands.removeMember("no-such-band", "m2")).rejects.toThrow();
    });

    it("현재 사용자가 owner가 아니면 거부한다 (시드 b1에는 참여하지 않은 상태)", async () => {
      const api = new MockApiClient();
      await expect(api.bands.removeMember("b1", "m2")).rejects.toThrow();
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
});
