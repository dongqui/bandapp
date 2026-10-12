import { describe, expect, it } from "vitest";
import { fanout, type NotificationEvent } from "./fanout.js";

const members = ["me", "a", "b", "c"];
const sessionReady: NotificationEvent = { kind: "session_ready", bandId: "band", sessionId: "s", actorId: "me" };
const topLevel: NotificationEvent = { kind: "comment", bandId: "band", sessionId: "s", actorId: "a", commentId: "c1", takeId: "t", parentAuthorId: null };
const replyToMe: NotificationEvent = { ...topLevel, commentId: "c2", parentAuthorId: "me" };

describe("fanout", () => {
  it("session_ready는 업로더 포함 전원에게 간다 (스펙 결정 3)", () => {
    expect(fanout(sessionReady, members, new Map())).toEqual(members.map((userId) => ({ userId, type: "session_ready" })));
  });

  it("sessionReady=false인 멤버는 빠진다", () => {
    const settings = new Map([["b", { sessionReady: false, comments: true, commentScope: "all" as const }]]);
    expect(fanout(sessionReady, members, settings).map((r) => r.userId)).toEqual(["me", "a", "c"]);
  });

  it("코멘트는 작성자를 빼고 모두 comment", () => {
    expect(fanout(topLevel, members, new Map())).toEqual([
      { userId: "me", type: "comment" },
      { userId: "b", type: "comment" },
      { userId: "c", type: "comment" },
    ]);
  });

  it("답글은 부모 작성자에게만 reply, 나머지는 comment", () => {
    expect(fanout(replyToMe, members, new Map())).toEqual([
      { userId: "me", type: "reply" },
      { userId: "b", type: "comment" },
      { userId: "c", type: "comment" },
    ]);
  });

  it("내 코멘트에 내가 단 답글은 나에게 안 온다 (작성자 제외가 먼저)", () => {
    const selfReply: NotificationEvent = { ...replyToMe, actorId: "me" };
    expect(fanout(selfReply, members, new Map()).map((r) => r.userId)).toEqual(["a", "b", "c"]);
  });

  it("commentScope=mine은 reply만 통과, comments=false는 전부 제외", () => {
    const settings = new Map([
      ["me", { sessionReady: true, comments: true, commentScope: "mine" as const }],
      ["b", { sessionReady: true, comments: true, commentScope: "mine" as const }],
      ["c", { sessionReady: true, comments: false, commentScope: "all" as const }],
    ]);
    expect(fanout(replyToMe, members, settings)).toEqual([{ userId: "me", type: "reply" }]);
    expect(fanout(topLevel, members, settings)).toEqual([]);
  });

  it("설정 행이 없으면 기본값(전부 on)", () => {
    expect(fanout(topLevel, ["me", "a"], new Map())).toEqual([{ userId: "me", type: "comment" }]);
  });
});
