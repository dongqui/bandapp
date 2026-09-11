import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { MockApiClient } from "./MockApiClient";

const ME = "u-mock";

describe("MockApiClient bands 관리", () => {
  it("시드: b1은 내가 owner, b2는 내가 member", async () => {
    const api = new MockApiClient();
    const bands = await api.bands.list();
    expect(bands.map((b) => b.id)).toEqual(["b1", "b2"]);
    const b1 = await api.bands.members("b1");
    expect(b1.find((m) => m.id === ME)?.role).toBe("owner");
    expect(b1.find((m) => m.id === ME)?.part).toBe("guitar");
    const b2 = await api.bands.members("b2");
    expect(b2.find((m) => m.id === ME)?.role).toBe("member");
    expect(b2.find((m) => m.role === "owner")?.id).not.toBe(ME);
  });

  it("rename은 owner만, 이름을 trim해서 저장한다", async () => {
    const api = new MockApiClient();
    const band = await api.bands.rename("b1", "  Saturday  ");
    expect(band.name).toBe("Saturday");
    await expect(api.bands.rename("b2", "X")).rejects.toMatchObject({ status: 403, code: "band_owner_only" });
  });

  it("rename은 trim 후 1~50자가 아니면 400", async () => {
    const api = new MockApiClient();
    await expect(api.bands.rename("b1", "   ")).rejects.toMatchObject({ status: 400 });
    await expect(api.bands.rename("b1", "a".repeat(51))).rejects.toMatchObject({ status: 400 });
  });

  it("transferOwnership은 역할을 교체하고, 본인이면 409, 없으면 404", async () => {
    const api = new MockApiClient();
    await api.bands.transferOwnership("b1", "m2");
    const members = await api.bands.members("b1");
    expect(members.find((m) => m.id === ME)?.role).toBe("member");
    expect(members.find((m) => m.id === "m2")?.role).toBe("owner");
    // 이제 내가 member라 403
    await expect(api.bands.transferOwnership("b1", "m3")).rejects.toMatchObject({ status: 403, code: "band_owner_only" });
    const fresh = new MockApiClient();
    await expect(fresh.bands.transferOwnership("b1", ME)).rejects.toMatchObject({ status: 409, code: "band_transfer_self" });
    await expect(fresh.bands.transferOwnership("b1", "nobody")).rejects.toMatchObject({ status: 404, code: "band_member_not_found" });
  });

  it("delete는 owner만, 목록에서 사라진다", async () => {
    const api = new MockApiClient();
    await expect(api.bands.delete("b2")).rejects.toBeInstanceOf(ApiError);
    await api.bands.delete("b1");
    expect((await api.bands.list()).map((b) => b.id)).toEqual(["b2"]);
  });

  it("leave: owner이고 남이 있으면 409 band_owner_must_transfer, member면 빠진다", async () => {
    const api = new MockApiClient();
    await expect(api.bands.leave("b1")).rejects.toMatchObject({ status: 409, code: "band_owner_must_transfer" });
    await api.bands.leave("b2");
    expect((await api.bands.list()).map((b) => b.id)).toEqual(["b1"]);
  });

  it("setMyPart는 자유 문자열을 받는다", async () => {
    const api = new MockApiClient();
    const me = await api.bands.setMyPart("b1", "  Synth  ");
    expect(me.part).toBe("Synth");
  });
});

describe("MockApiClient sessions.peaksUrl", () => {
  it("Mock에는 사이드카가 없다 — 빈 url (앱은 128버킷 폴백)", async () => {
    const api = new MockApiClient();
    const res = await api.sessions.peaksUrl("s1");
    expect(res.url).toBe("");
    expect(typeof res.expiresAt).toBe("string");
  });
});

describe("MockApiClient takes 편집", () => {
  it("update는 경계·version을 바꾸고 코멘트 atSec을 옮기며 잠시 뒤 ready가 된다", async () => {
    const api = new MockApiClient();
    api.recutDelayMs = 0;
    const [t] = await api.takes.list("s1");
    await api.comments.create({ takeId: t!.id }, { atSec: 30, text: "hi" });
    const updated = await api.takes.update(t!.id, { startMs: t!.startMs + 10_000, endMs: t!.endMs, version: t!.version });
    expect(updated).toMatchObject({ startMs: t!.startMs + 10_000, version: t!.version + 1, audioStatus: "updating" });
    // s1-t0에는 시드 코멘트가 이미 있어 목록의 첫 항목이 아닐 수 있다 — 방금 만든 코멘트를 직접 찾는다
    const c = (await api.comments.list({ takeId: t!.id })).find((x) => x.text === "hi");
    expect(c!.atSec).toBe(20);
    await new Promise((r) => setTimeout(r, 5));
    const [after] = await api.takes.list("s1");
    expect(after!.audioStatus).toBe("ready");
  });
  it("version이 다르면 409 take_version_conflict, 겹치면 400 take_overlap", async () => {
    const api = new MockApiClient();
    const [a, b] = await api.takes.list("s1");
    await expect(api.takes.update(a!.id, { startMs: a!.startMs, endMs: a!.endMs, version: 99 })).rejects.toMatchObject({ status: 409, code: "take_version_conflict" });
    await expect(api.takes.update(a!.id, { startMs: a!.startMs, endMs: b!.startMs + 1, version: a!.version })).rejects.toMatchObject({ status: 400, code: "take_overlap" });
  });
  it("remove는 take와 코멘트를 지우고 takeCount를 줄이며 남은 이름은 그대로", async () => {
    const api = new MockApiClient();
    const before = await api.takes.list("s1");
    await api.comments.create({ takeId: before[0]!.id }, { atSec: 1, text: "x" });
    await api.takes.remove(before[0]!.id);
    const after = await api.takes.list("s1");
    expect(after).toHaveLength(before.length - 1);
    expect(after[0]!.name).toBe(before[1]!.name);
    expect(await api.comments.list({ takeId: before[0]!.id })).toEqual([]);
    const s = await api.sessions.get("s1");
    expect(s.takeCount).toBe(before.length - 1);
  });
});
