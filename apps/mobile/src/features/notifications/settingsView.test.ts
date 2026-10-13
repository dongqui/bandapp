import { describe, expect, it } from "vitest";
import { meNfValue, settingsSummary } from "./settingsView";

const s = (bandId: string, sessionReady: boolean, comments: boolean, commentScope: "all" | "mine" = "all") => ({ bandId, sessionReady, comments, commentScope });

describe("settingsSummary", () => {
  it("6가지", () => {
    expect(settingsSummary(s("b", true, true))).toBe("all");
    expect(settingsSummary(s("b", true, true, "mine"))).toBe("mine");
    expect(settingsSummary(s("b", true, false))).toBe("sessionsOnly");
    expect(settingsSummary(s("b", false, true))).toBe("commentsOnly");
    expect(settingsSummary(s("b", false, true, "mine"))).toBe("repliesOnly");
    expect(settingsSummary(s("b", false, false))).toBe("off");
  });
});

describe("meNfValue", () => {
  const all = [s("a", true, true), s("b", true, false)];
  it("ask/denied면 off, 전부 on이면 on, 일부면 partial", () => {
    expect(meNfValue("ask", all)).toEqual({ kind: "off" });
    expect(meNfValue("denied", all)).toEqual({ kind: "off" });
    // unavailable(Firebase 없는 빌드)은 설정이 인박스 행도 거르므로 설정 값 그대로 (결정 14)
    expect(meNfValue("unavailable", all)).toEqual({ kind: "on" });
    expect(meNfValue("unavailable", [s("a", false, false), s("b", false, false)])).toEqual({ kind: "off" });
    expect(meNfValue("allowed", all)).toEqual({ kind: "on" });
    expect(meNfValue("allowed", [s("a", true, true), s("b", false, false)])).toEqual({ kind: "partial", on: 1, total: 2 });
    expect(meNfValue("allowed", [s("a", false, false)])).toEqual({ kind: "off" });
    expect(meNfValue("allowed", [])).toEqual({ kind: "off" });
  });
});
