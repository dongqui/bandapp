import { describe, expect, it } from "vitest";
import { autoPanPxPerFrame, EDGE_MAX_PX_PER_FRAME, hitTestHandle, previewSeekMs, shiftCommentAtSec, trimDraft } from "./edit";

const v = { startMs: 0, msPerPx: 100, widthPx: 400 }; // 0~40s
const draft = { startMs: 10_000, endMs: 30_000 }; // x 100 ~ 300
const none = { prevEndMs: null, nextStartMs: null };

describe("hitTestHandle", () => {
  it("핸들 ±24px 안이면 그 핸들, 밖이면 null", () => {
    expect(hitTestHandle(v, draft, 100)).toBe("start");
    expect(hitTestHandle(v, draft, 123)).toBe("start");
    expect(hitTestHandle(v, draft, 125)).toBeNull();
    expect(hitTestHandle(v, draft, 290)).toBe("end");
    expect(hitTestHandle(v, draft, 200)).toBeNull();
  });
  it("둘 다 맞으면 가까운 쪽", () => {
    const tiny = { startMs: 10_000, endMs: 12_000 }; // x 100 ~ 120
    expect(hitTestHandle(v, tiny, 108)).toBe("start");
    expect(hitTestHandle(v, tiny, 113)).toBe("end");
  });
});

describe("trimDraft", () => {
  it("start는 [max(0, prevEnd), end − MIN], end는 [start + MIN, min(duration, nextStart)]", () => {
    expect(trimDraft(draft, "start", -5000, none, 60_000)).toEqual({ startMs: 0, endMs: 30_000 });
    expect(trimDraft(draft, "start", 29_900, none, 60_000)).toEqual({ startMs: 29_750, endMs: 30_000 });
    expect(trimDraft(draft, "end", 99_000, none, 60_000)).toEqual({ startMs: 10_000, endMs: 60_000 });
    expect(trimDraft(draft, "end", 10_100, none, 60_000)).toEqual({ startMs: 10_000, endMs: 10_250 });
  });
  it("이웃 경계에서 멈춘다", () => {
    const n = { prevEndMs: 8_000, nextStartMs: 35_000 };
    expect(trimDraft(draft, "start", 2_000, n, 60_000).startMs).toBe(8_000);
    expect(trimDraft(draft, "end", 50_000, n, 60_000).endMs).toBe(35_000);
  });
  it("정수 ms로 반올림한다", () => {
    expect(trimDraft(draft, "start", 12_345.6, none, 60_000).startMs).toBe(12_346);
  });
});

describe("autoPanPxPerFrame", () => {
  it("가장자리 24px 밖은 0, 안쪽은 넘친 만큼 비례, 끝에서 최대", () => {
    expect(autoPanPxPerFrame(200, 400)).toBe(0);
    expect(autoPanPxPerFrame(24, 400)).toBe(0);
    expect(autoPanPxPerFrame(12, 400)).toBeCloseTo(-EDGE_MAX_PX_PER_FRAME / 2);
    expect(autoPanPxPerFrame(0, 400)).toBe(-EDGE_MAX_PX_PER_FRAME);
    expect(autoPanPxPerFrame(400, 400)).toBe(EDGE_MAX_PX_PER_FRAME);
    expect(autoPanPxPerFrame(-10, 400)).toBe(-EDGE_MAX_PX_PER_FRAME);
  });
});

describe("previewSeekMs / shiftCommentAtSec", () => {
  it("start 핸들은 start, end 핸들은 end − 2s (start 아래로는 안 감)", () => {
    expect(previewSeekMs(draft, "start")).toBe(10_000);
    expect(previewSeekMs(draft, "end")).toBe(28_000);
    expect(previewSeekMs({ startMs: 10_000, endMs: 11_000 }, "end")).toBe(10_000);
  });
  it("코멘트는 절대 시각 유지", () => {
    expect(shiftCommentAtSec(30, 10_000, 20_000)).toBe(20);
    expect(shiftCommentAtSec(5, 10_000, 20_000)).toBe(-5);
  });
});
