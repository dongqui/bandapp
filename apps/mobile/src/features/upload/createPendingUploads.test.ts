import { describe, expect, it, vi } from "vitest";
import { createMemoryFs, createPendingUploads, type PendingUpload } from "./createPendingUploads";

const rec = (sessionId: string, fileUri: string): PendingUpload => ({
  sessionId, bandId: "b1", fileUri, source: "recording", createdAt: "2026-09-10T10:00:00.000Z",
});

// TTL(7일) 판정에 실제 시계를 쓰면 createdAt이 고정된 레코드가 시간이 지날수록 만료되어 버린다.
// TTL 자체를 검증하지 않는 테스트는 이 고정 시계를 넘겨 sweepOrphans()가 항상 신선한 레코드로 보게 한다.
const NOW = () => Date.parse("2026-09-10T12:00:00.000Z");

describe("createPendingUploads", () => {
  it("stage moves the file into uploads/ and returns the new URI", async () => {
    const fs = createMemoryFs({ "file:///cache/rec.m4a": "audio" });
    const store = createPendingUploads(fs, NOW);
    const staged = await store.stage("file:///cache/rec.m4a");
    expect(staged.startsWith("file:///docs/uploads/")).toBe(true);
    expect(staged.endsWith(".m4a")).toBe(true);
    expect(fs.files.has("file:///cache/rec.m4a")).toBe(false);
    expect(fs.files.get(staged)).toBe("audio");
  });

  it("stage throws when the source file does not exist", async () => {
    const store = createPendingUploads(createMemoryFs(), NOW);
    await expect(store.stage("blob:http://localhost/abc")).rejects.toThrow();
  });

  it("add/get/list round-trip through pending.json", async () => {
    const fs = createMemoryFs();
    const store = createPendingUploads(fs, NOW);
    await store.add(rec("s1", "file:///docs/uploads/a.m4a"));
    await store.add(rec("s2", "file:///docs/uploads/b.m4a"));
    expect(await store.get("s1")).toEqual(rec("s1", "file:///docs/uploads/a.m4a"));
    expect(await store.get("zz")).toBeNull();
    expect((await store.list()).map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
    // 새 스토어 인스턴스가 같은 fs를 읽어도 보인다 (앱 재시작 흉내)
    expect(await createPendingUploads(fs, NOW).get("s2")).not.toBeNull();
  });

  it("discard removes the record and the file, and succeeds when the file is already gone", async () => {
    const fs = createMemoryFs({ "file:///docs/uploads/a.m4a": "x" });
    const store = createPendingUploads(fs, NOW);
    await store.add(rec("s1", "file:///docs/uploads/a.m4a"));
    await store.add(rec("s2", "file:///docs/uploads/missing.m4a"));
    await store.discard("s1");
    expect(fs.files.has("file:///docs/uploads/a.m4a")).toBe(false);
    expect(await store.get("s1")).toBeNull();
    await expect(store.discard("s2")).resolves.toBeUndefined();
    expect(await store.get("s2")).toBeNull();
    await expect(store.discard("never")).resolves.toBeUndefined();
  });

  it("sweepOrphans deletes uploads/*.m4a that no record points to, keeping pending.json", async () => {
    const fs = createMemoryFs({
      "file:///docs/uploads/keep.m4a": "k",
      "file:///docs/uploads/orphan.m4a": "o",
    });
    const store = createPendingUploads(fs, NOW);
    await store.add(rec("s1", "file:///docs/uploads/keep.m4a"));
    await store.sweepOrphans();
    expect(fs.files.has("file:///docs/uploads/keep.m4a")).toBe(true);
    expect(fs.files.has("file:///docs/uploads/orphan.m4a")).toBe(false);
    expect(fs.files.has("file:///docs/uploads/pending.json")).toBe(true);
  });

  it("treats a corrupt pending.json as empty and warns", async () => {
    const fs = createMemoryFs({ "file:///docs/uploads/pending.json": "{not json" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createPendingUploads(fs, NOW);
    expect(await store.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never throws from add/get/list/discard/sweepOrphans when the fs fails", async () => {
    const broken = createMemoryFs({
      "file:///docs/uploads/pending.json": JSON.stringify({ s1: rec("s1", "file:///docs/uploads/a.m4a") }),
      "file:///docs/uploads/a.m4a": "audio",
    });
    broken.writeAsStringAsync = async () => { throw new Error("EIO"); };
    broken.readDirectoryAsync = async () => { throw new Error("EIO"); };
    broken.deleteAsync = async () => { throw new Error("EIO"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createPendingUploads(broken, NOW);
    await expect(store.add(rec("s2", "file:///docs/uploads/b.m4a"))).resolves.toBeUndefined();
    await expect(store.sweepOrphans()).resolves.toBeUndefined();
    await expect(store.dropFile("file:///docs/uploads/none.m4a")).resolves.toBeUndefined();
    await expect(store.discard("s1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  describe("7-day TTL (finding B)", () => {
    const fixedNow = Date.parse("2026-09-10T00:00:00.000Z");

    it("sweepOrphans discards a record (and its file) older than 7 days", async () => {
      const fs = createMemoryFs({ "file:///docs/uploads/old.m4a": "o" });
      const store = createPendingUploads(fs, () => fixedNow);
      await store.add({ ...rec("old", "file:///docs/uploads/old.m4a"), createdAt: "2026-09-02T00:00:00.000Z" }); // 8일 전
      await store.sweepOrphans();
      expect(await store.get("old")).toBeNull();
      expect(fs.files.has("file:///docs/uploads/old.m4a")).toBe(false);
    });

    it("sweepOrphans keeps a fresh record and its file", async () => {
      const fs = createMemoryFs({ "file:///docs/uploads/fresh.m4a": "f" });
      const store = createPendingUploads(fs, () => fixedNow);
      await store.add({ ...rec("fresh", "file:///docs/uploads/fresh.m4a"), createdAt: "2026-09-09T00:00:00.000Z" }); // 1일 전
      await store.sweepOrphans();
      expect(await store.get("fresh")).not.toBeNull();
      expect(fs.files.has("file:///docs/uploads/fresh.m4a")).toBe(true);
    });

    it("treats an unparseable createdAt as expired", async () => {
      const fs = createMemoryFs({ "file:///docs/uploads/bad.m4a": "b" });
      const store = createPendingUploads(fs, () => fixedNow);
      await store.add({ ...rec("bad", "file:///docs/uploads/bad.m4a"), createdAt: "not-a-date" });
      await store.sweepOrphans();
      expect(await store.get("bad")).toBeNull();
      expect(fs.files.has("file:///docs/uploads/bad.m4a")).toBe(false);
    });
  });
});
