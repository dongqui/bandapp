import { describe, expect, it } from "vitest";
import { pushText, type PushTextInput } from "./push-text.js";

const base: PushTextInput = { type: "comment", actorName: "Minsu", isSelf: false, sessionLabel: "Full set run-through", takeCount: 7, takeName: "Take 1", commentText: "Rushing going into the chorus" };

describe("pushText", () => {
  it("en: 코멘트·답글·세션", () => {
    expect(pushText("en-US", base)).toEqual({ title: "Minsu commented on Take 1", body: "“Rushing going into the chorus”" });
    expect(pushText("en", { ...base, type: "reply" })).toEqual({ title: "Minsu replied to you on Take 1", body: "“Rushing going into the chorus”" });
    expect(pushText("en", { ...base, type: "session_ready", actorName: "Jihoon" })).toEqual({ title: "Jihoon's recording is ready", body: "Full set run-through · 7 takes found" });
    expect(pushText("en", { ...base, type: "session_ready", isSelf: true, takeCount: 1 })).toEqual({ title: "Your recording is ready", body: "Full set run-through · 1 take found" });
  });

  it("ko: 코멘트·답글·세션", () => {
    expect(pushText("ko-KR", base)).toEqual({ title: "Minsu님이 Take 1에 코멘트를 남겼어요", body: "“Rushing going into the chorus”" });
    expect(pushText("ko", { ...base, type: "reply" })).toEqual({ title: "Minsu님이 Take 1의 내 코멘트에 답글을 남겼어요", body: "“Rushing going into the chorus”" });
    expect(pushText("ko", { ...base, type: "session_ready", actorName: "Jihoon" })).toEqual({ title: "Jihoon님의 녹음이 준비됐어요", body: "Full set run-through · 테이크 7개" });
    expect(pushText("ko", { ...base, type: "session_ready", isSelf: true })).toEqual({ title: "내 녹음이 준비됐어요", body: "Full set run-through · 테이크 7개" });
  });

  it("원본 녹음 코멘트(takeName null)와 actor 없음·이름 없음", () => {
    expect(pushText("en", { ...base, takeName: null }).title).toBe("Minsu commented on the original recording");
    expect(pushText("ko", { ...base, takeName: null }).title).toBe("Minsu님이 원본 녹음에 코멘트를 남겼어요");
    expect(pushText("en", { ...base, actorName: null }).title).toBe("A former member commented on Take 1");
    expect(pushText("ko", { ...base, actorName: null }).title).toBe("탈퇴한 멤버님이 Take 1에 코멘트를 남겼어요");
    expect(pushText("en", { ...base, actorName: "" }).title).toBe("? commented on Take 1");
  });

  it("모르는 locale은 en, 본문은 200자에서 자른다", () => {
    expect(pushText("fr", base).title).toBe("Minsu commented on Take 1");
    const long = "a".repeat(300);
    expect(pushText("en", { ...base, commentText: long }).body).toBe(`“${"a".repeat(199)}…”`);
  });
});
