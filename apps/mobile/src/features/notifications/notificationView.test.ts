import "../../test/tz"; // 반드시 첫 import — 날짜 경계를 Asia/Seoul로 고정
import type { NotificationItem } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { groupByDay, notificationView, whenLabel } from "./notificationView";

const now = new Date("2026-08-29T21:24:00+09:00");
const base: NotificationItem = {
  id: "n1", type: "comment",
  actor: { id: "m2", name: "Minsu" },
  session: { id: "s1", title: "Aug 27 Rehearsal", name: "Full set run-through", startedAt: "2026-08-27T19:03:00+09:00", takeCount: 7, durationSec: 8040 },
  take: { id: "t", index: 0, name: "Take 1" },
  comment: { id: "c", atSec: 133, text: "Rushing going into the chorus" },
  readAt: null, createdAt: "2026-08-29T19:24:00+09:00",
};

describe("notificationView", () => {
  it("코멘트: 제목 재료·본문·메타·when·unread", () => {
    const v = notificationView(base, "me", now);
    expect(v).toMatchObject({ id: "n1", kind: "comment", actorName: "Minsu", targetName: "Take 1", body: "“Rushing going into the chorus”", meta: "FULL SET RUN-THROUGH · 02:13", when: "2h", unread: true, initial: "M" });
    expect(v.target).toEqual({ notificationId: "n1", bandId: "", sessionId: "s1", takeId: "t", atSec: 133 });
  });
  it("답글은 kind reply, 원본 녹음 코멘트는 targetName null·takeId orig", () => {
    const v = notificationView({ ...base, type: "reply", take: null }, "me", now);
    expect(v.kind).toBe("reply");
    expect(v.targetName).toBeNull();
    expect(v.target.takeId).toBe("orig");
  });
  it("세션 완료: 본인/타인, 메타는 날짜·길이, 세션 이름 없으면 title", () => {
    const item: NotificationItem = { ...base, type: "session_ready", take: null, comment: null, actor: { id: "me", name: "Dongjin" }, readAt: "2026-08-29T20:00:00+09:00" };
    const self = notificationView(item, "me", now);
    expect(self).toMatchObject({ kind: "session_ready_self", body: "Full set run-through", takeCount: 7, meta: "AUG 27 · 2H 14M", unread: false });
    expect(self.target).toMatchObject({ takeId: null, atSec: null });
    const other = notificationView({ ...item, actor: { id: "m3", name: "Jihoon" }, session: { ...item.session, name: null } }, "me", now);
    expect(other).toMatchObject({ kind: "session_ready", actorName: "Jihoon", body: "Aug 27 Rehearsal" });
  });
  it("actor null → formerMember 표시 플래그, 이름 비면 ?", () => {
    expect(notificationView({ ...base, actor: null }, "me", now)).toMatchObject({ actorName: null, initial: "?" });
    expect(notificationView({ ...base, actor: { id: "x", name: null } }, "me", now)).toMatchObject({ actorName: "?", initial: "?" });
  });
});

describe("whenLabel", () => {
  it("now / m / h / 날짜", () => {
    expect(whenLabel("2026-08-29T21:23:40+09:00", now)).toBe("now");
    expect(whenLabel("2026-08-29T21:10:00+09:00", now)).toBe("14m");
    expect(whenLabel("2026-08-29T18:24:00+09:00", now)).toBe("3h");
    expect(whenLabel("2026-08-28T23:50:00+09:00", now)).toBe("Aug 28");
  });
});

describe("groupByDay", () => {
  it("로컬 기준 오늘만 TODAY, 어제 23:50은 EARLIER (1h 전이어도)", () => {
    const todayLate = new Date("2026-08-29T00:30:00+09:00");
    const a = notificationView({ ...base, id: "a", createdAt: "2026-08-29T00:10:00+09:00" }, "me", todayLate);
    const b = notificationView({ ...base, id: "b", createdAt: "2026-08-28T23:50:00+09:00" }, "me", todayLate);
    expect(groupByDay([a, b], todayLate)).toEqual([
      { label: "today", items: [a] },
      { label: "earlier", items: [b] },
    ]);
    expect(groupByDay([b], todayLate)).toEqual([{ label: "earlier", items: [b] }]);
    expect(groupByDay([], todayLate)).toEqual([]);
  });
});
