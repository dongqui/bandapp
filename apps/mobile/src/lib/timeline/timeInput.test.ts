import { describe, expect, it } from "vitest";
import { clockDigits, formatClockDigits, parseClockDigits, secToClockInput, validateTimeInput } from "./timeInput";

describe("clockDigits", () => {
  it("숫자만 남기고 앞의 0은 버린다 — 콜론·공백·붙여넣은 서식은 무시", () => {
    expect(clockDigits("12:30")).toBe("1230");
    expect(clockDigits("0:05")).toBe("5");
    expect(clockDigits(" 1 2 ")).toBe("12");
    expect(clockDigits("00:00")).toBe("");
    expect(clockDigits("")).toBe("");
  });
  it("h:mm:ss까지 6자리만 — 더 치면 앞자리가 밀려 나간다", () => {
    expect(clockDigits("1234567")).toBe("234567");
  });
});

describe("formatClockDigits", () => {
  it("오른쪽부터 채워 콜론을 자동으로 넣는다 (타이머식)", () => {
    expect(formatClockDigits("")).toBe("");
    expect(formatClockDigits("1")).toBe("0:01");
    expect(formatClockDigits("12")).toBe("0:12");
    expect(formatClockDigits("123")).toBe("1:23");
    expect(formatClockDigits("1230")).toBe("12:30");
    expect(formatClockDigits("12305")).toBe("1:23:05");
    expect(formatClockDigits("123456")).toBe("12:34:56");
  });
});

describe("parseClockDigits", () => {
  it("자리수를 초로 바꾼다", () => {
    expect(parseClockDigits("1")).toBe(1);
    expect(parseClockDigits("130")).toBe(90);
    expect(parseClockDigits("1230")).toBe(750);
    expect(parseClockDigits("10203")).toBe(3723);
  });
  it("비었거나 초·분이 60 이상이면 null", () => {
    expect(parseClockDigits("")).toBeNull();
    expect(parseClockDigits("175")).toBeNull();
    expect(parseClockDigits("16000")).toBeNull();
  });
});

describe("secToClockInput", () => {
  it("fmtClock과 달리 분을 0으로 채우지 않는다 — 입력 칸 표시용", () => {
    expect(secToClockInput(5)).toBe("0:05");
    expect(secToClockInput(90)).toBe("1:30");
    expect(secToClockInput(750)).toBe("12:30");
    expect(secToClockInput(3661)).toBe("1:01:01");
  });
});

describe("validateTimeInput", () => {
  // 선택 take 앞은 0:50에 끝나고, 뒤는 5:00에 시작하며, 녹음은 10:00
  const ctx = { prevEndMs: 50_000, nextStartMs: 300_000, durationMs: 600_000 };

  it("정상이면 ms 범위", () => {
    expect(validateTimeInput("100", "230", ctx)).toEqual({ startMs: 60_000, endMs: 150_000 });
    expect(validateTimeInput("50", "500", ctx)).toEqual({ startMs: 50_000, endMs: 300_000 });
  });
  it("형식 오류", () => {
    expect(validateTimeInput("", "230", ctx)).toEqual({ error: "Use m:ss or h:mm:ss, like 12:30." });
    expect(validateTimeInput("175", "230", ctx)).toEqual({ error: "Use m:ss or h:mm:ss, like 12:30." });
  });
  it("끝이 시작 + 1초보다 앞이면", () => {
    expect(validateTimeInput("100", "100", ctx)).toEqual({ error: "End has to be at least 1 second after start." });
    expect(validateTimeInput("100", "59", ctx)).toEqual({ error: "End has to be at least 1 second after start." });
  });
  it("앞 take와 겹치면 — 앞 take 끝을 올림해 알려 준다", () => {
    expect(validateTimeInput("49", "230", ctx)).toEqual({ error: "Start overlaps the previous take (ends 0:50)." });
    expect(validateTimeInput("50", "230", { ...ctx, prevEndMs: 50_500 })).toEqual({ error: "Start overlaps the previous take (ends 0:51)." });
  });
  it("뒤 take와 겹치면 — 뒤 take 시작을 내림해 알려 준다", () => {
    expect(validateTimeInput("100", "501", ctx)).toEqual({ error: "End overlaps the next take (starts 5:00)." });
    expect(validateTimeInput("100", "501", { ...ctx, nextStartMs: 300_900 })).toEqual({ error: "End overlaps the next take (starts 5:00)." });
  });
  it("뒤 take가 없고 녹음 끝을 넘으면", () => {
    expect(validateTimeInput("100", "1001", { ...ctx, nextStartMs: null })).toEqual({ error: "End is past the end of the recording (10:00)." });
    expect(validateTimeInput("100", "1000", { ...ctx, nextStartMs: null })).toEqual({ startMs: 60_000, endMs: 600_000 });
  });
  it("안 건드린 칸은 초안의 정확한 ms를 그대로 쓴다 — 초 단위로 내리면 앞 take 끝(50.5s)에 맞춘 시작이 겹침으로 오판된다", () => {
    const c = { ...ctx, prevEndMs: 50_500 };
    expect(validateTimeInput({ ms: 50_500 }, "230", c)).toEqual({ startMs: 50_500, endMs: 150_000 });
    expect(validateTimeInput("100", { ms: 150_250 }, c)).toEqual({ startMs: 60_000, endMs: 150_250 });
    expect(validateTimeInput({ ms: 50_500 }, { ms: 51_000 }, c)).toEqual({ error: "End has to be at least 1 second after start." });
  });
});
