import { originalKey, peaksKey, takeKey, titleFor, toSession } from "./session-mapper.js";

describe("titleFor", () => {
  it("uses the client's local date from the offset string", () => {
    expect(titleFor("2026-09-04T00:30:00+09:00")).toBe("Sep 4 Rehearsal");
    // 같은 순간이지만 UTC로 적으면 전날이다 — 문자열의 날짜 부분을 그대로 믿는다
    expect(titleFor("2026-09-03T15:30:00.000Z")).toBe("Sep 3 Rehearsal");
  });
});

describe("toSession", () => {
  it("maps ms to seconds and null name to undefined", () => {
    const session = toSession({
      id: "s1",
      bandId: "b1",
      title: "Sep 4 Rehearsal",
      name: null,
      status: "ready",
      startedAt: new Date("2026-09-04T10:00:00Z"),
      durationMs: 2716601,
      takeCount: 3,
      commentCount: 2,
      peaks: null,
      peaksKey: null,
      updatedAt: new Date("2026-09-04T10:00:00Z"),
    });
    expect(session).toEqual({
      id: "s1",
      bandId: "b1",
      title: "Sep 4 Rehearsal",
      status: "ready",
      startedAt: "2026-09-04T10:00:00.000Z",
      durationSec: 2717,
      takeCount: 3,
      commentCount: 2,
      peaks: null,
    });
    expect("name" in session).toBe(false);
  });
  it("reports 0 seconds while duration is unknown", () => {
    expect(toSession({ id: "s", bandId: "b", title: "t", name: "N", status: "uploading", startedAt: new Date(), durationMs: null, takeCount: 0, commentCount: 0, peaks: null, updatedAt: new Date() }).durationSec).toBe(0);
  });
  it("passes an existing peaks array through unchanged", () => {
    const peaks = Array.from({ length: 128 }, (_, i) => i * 2);
    const session = toSession({
      id: "s2",
      bandId: "b1",
      title: "Sep 4 Rehearsal",
      name: null,
      status: "ready",
      startedAt: new Date("2026-09-04T10:00:00Z"),
      durationMs: 1000,
      takeCount: 1,
      commentCount: 0,
      peaks,
      updatedAt: new Date("2026-09-04T10:00:00Z"),
    });
    expect(session.peaks).toEqual(peaks);
  });
});

describe("object keys", () => {
  it("nest under band and session", () => {
    expect(originalKey("b", "s")).toBe("bands/b/sessions/s/original.m4a");
    expect(takeKey("b", "s", "t")).toBe("bands/b/sessions/s/takes/t.m4a");
  });
});

describe("peaksKey", () => {
  it("원본·take와 같은 세션 접두어 아래 peaks.bin", () => {
    expect(peaksKey("b1", "s1")).toBe("bands/b1/sessions/s1/peaks.bin");
  });
});

describe("toSession peaksKey", () => {
  it("peaksKey는 wire Session에 노출되지 않는다", () => {
    const session = toSession({ id: "s", bandId: "b", title: "t", name: null, status: "ready", startedAt: new Date(), durationMs: 1000, takeCount: 0, commentCount: 0, peaks: null, peaksKey: "bands/b/sessions/s/peaks.bin", updatedAt: new Date() });
    expect(session).not.toHaveProperty("peaksKey");
  });
});
