import { describe, expect, it } from "vitest";
import { clockRange, dateLabel, fmtClock, fmtDuration, monthLabel, startLabel } from "./time";

describe("time", () => {
  it("fmtClock", () => {
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(272)).toBe("04:32");
    expect(fmtClock(8040)).toBe("2:14:00");
  });
  it("fmtDuration", () => {
    expect(fmtDuration(45)).toBe("45s");
    expect(fmtDuration(320)).toBe("5m 20s");
    expect(fmtDuration(8040)).toBe("2h 14m");
  });
  it("labels from local ISO", () => {
    expect(startLabel("2026-08-27T19:03:00")).toBe("19:03");
    expect(dateLabel("2026-08-27T19:03:00")).toBe("AUG 27 · THU");
    expect(monthLabel("2026-08-27T19:03:00")).toBe("AUGUST 2026");
    expect(clockRange("2026-08-27T19:03:00", 8040)).toBe("19:03 – 21:17");
  });
  it("clockRange wraps past midnight", () => {
    expect(clockRange("2026-08-27T23:30:00", 3600)).toBe("23:30 – 00:30");
  });
});
