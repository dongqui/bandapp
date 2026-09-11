import { describe, expect, it } from "vitest";
import {
  clampViewport,
  closestMsPerPx,
  fitRange,
  keepCenterOnResize,
  panViewport,
  timeToX,
  viewportEndMs,
  widestMsPerPx,
  xToTime,
  zoomAtFocal,
  type Viewport,
} from "./viewport";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DURATIONS = [10 * SEC, 1 * MIN, 10 * MIN, 2 * HOUR, 3 * HOUR, 6 * HOUR];
const WIDTHS = [320, 390, 768];

/** 시드 고정 LCG — 랜덤 불변식 테스트가 재현 가능해야 한다 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function full(durationMs: number, widthPx: number): Viewport {
  return { startMs: 0, msPerPx: widestMsPerPx(durationMs, widthPx), widthPx };
}

function expectInvariants(v: Viewport, durationMs: number) {
  expect(v.startMs).toBeGreaterThanOrEqual(0);
  expect(viewportEndMs(v)).toBeLessThanOrEqual(durationMs + 1e-6);
  expect(v.msPerPx).toBeLessThanOrEqual(widestMsPerPx(durationMs, v.widthPx) + 1e-9);
  expect(v.msPerPx).toBeGreaterThanOrEqual(closestMsPerPx(durationMs, v.widthPx) - 1e-9);
}

describe("timeToX / xToTime", () => {
  it("서로 역함수다", () => {
    for (const d of DURATIONS) {
      for (const w of WIDTHS) {
        const v = { startMs: d / 3, msPerPx: 12.5, widthPx: w };
        for (const t of [0, d / 3, d / 2, d]) expect(xToTime(v, timeToX(v, t))).toBeCloseTo(t, 6);
      }
    }
  });
  it("viewportEndMs = start + width·msPerPx", () => {
    expect(viewportEndMs({ startMs: 1000, msPerPx: 10, widthPx: 100 })).toBe(2000);
  });
});

describe("줌 범위", () => {
  it("widest는 전체가 한 화면, closest는 5초가 한 화면", () => {
    expect(widestMsPerPx(3 * HOUR, 390)).toBeCloseTo((3 * HOUR) / 390);
    expect(closestMsPerPx(3 * HOUR, 390)).toBeCloseTo(5000 / 390);
  });
  it("5초보다 짧은 녹음은 closest가 widest와 같다 (역전 없음)", () => {
    expect(closestMsPerPx(3 * SEC, 390)).toBe(widestMsPerPx(3 * SEC, 390));
  });
  it("폭 0은 1로 취급한다", () => {
    expect(Number.isFinite(widestMsPerPx(MIN, 0))).toBe(true);
  });
});

describe("clampViewport", () => {
  it("msPerPx를 먼저 자르고 그 폭으로 startMs를 자른다", () => {
    const d = 10 * MIN;
    const v = clampViewport({ startMs: 10 * MIN, msPerPx: 1, widthPx: 390 }, d);
    expectInvariants(v, d);
    expect(v.msPerPx).toBeCloseTo(closestMsPerPx(d, 390));
    // start가 끝을 넘었으니 5초 창이 끝에 딱 걸치도록 당긴다
    expect(viewportEndMs(v)).toBeCloseTo(d);
  });
  it("녹음보다 넓게 줌아웃하면 전체 보기로 고정", () => {
    const d = MIN;
    const v = clampViewport({ startMs: 0, msPerPx: 1e9, widthPx: 390 }, d);
    expect(v.msPerPx).toBeCloseTo(widestMsPerPx(d, 390));
    expect(v.startMs).toBe(0);
  });
  it("음수 start는 0", () => {
    expect(clampViewport({ startMs: -5000, msPerPx: 100, widthPx: 100 }, HOUR).startMs).toBe(0);
  });
});

describe("panViewport", () => {
  it("오른쪽으로 끌면 과거로 간다", () => {
    const v = { startMs: 60 * SEC, msPerPx: 100, widthPx: 100 };
    expect(panViewport(v, 10, HOUR).startMs).toBe(59 * SEC);
    expect(panViewport(v, -10, HOUR).startMs).toBe(61 * SEC);
  });
  it("처음·끝을 넘지 않는다", () => {
    const v = { startMs: 0, msPerPx: 100, widthPx: 100 };
    expect(panViewport(v, 50, HOUR).startMs).toBe(0);
    const end = { startMs: HOUR - 10 * SEC, msPerPx: 100, widthPx: 100 };
    expect(panViewport(end, -50, HOUR).startMs).toBe(HOUR - 10 * SEC);
  });
});

describe("zoomAtFocal", () => {
  it("focal 아래의 시각이 그 자리에 남는다 — 0.5x~5x 20회 왕복", () => {
    const d = 3 * HOUR;
    let v = { startMs: 38 * MIN, msPerPx: 1000, widthPx: 390 };
    const focalX = 150;
    const focalMs = xToTime(v, focalX);
    const scales = [2, 0.5, 5, 0.2, 1.5, 0.75];
    for (let i = 0; i < 20; i++) {
      v = zoomAtFocal(v, focalX, scales[i % scales.length]!, d);
      expectInvariants(v, d);
      expect(Math.abs(timeToX(v, focalMs) - focalX)).toBeLessThan(0.5);
    }
  });
  it("scale > 1이면 msPerPx가 줄어든다(확대)", () => {
    const v = { startMs: 0, msPerPx: 1000, widthPx: 390 };
    expect(zoomAtFocal(v, 100, 2, HOUR).msPerPx).toBeCloseTo(500);
  });
  it("녹음 끝에서 줌아웃해도 빈 화면이 없다 (22-H)", () => {
    const d = 10 * MIN;
    const v = { startMs: d - 30 * SEC, msPerPx: closestMsPerPx(d, 390), widthPx: 390 };
    const out = zoomAtFocal(v, 380, 0.05, d);
    expectInvariants(out, d);
    expect(viewportEndMs(out)).toBeLessThanOrEqual(d);
  });
  it("최대 줌을 넘기면 5초 창에서 멈추고 focal은 유지한다", () => {
    const d = HOUR;
    const v = { startMs: 10 * MIN, msPerPx: 20, widthPx: 390 };
    const focalMs = xToTime(v, 200);
    const out = zoomAtFocal(v, 200, 100, d);
    expect(out.msPerPx).toBeCloseTo(closestMsPerPx(d, 390));
    expect(timeToX(out, focalMs)).toBeCloseTo(200, 3);
  });
});

describe("fitRange", () => {
  it("구간 + 좌우 20% 여백이 화면에 들어온다", () => {
    const d = HOUR;
    const v = fitRange(390, 10 * MIN, 12 * MIN, 0.2, d);
    expectInvariants(v, d);
    expect(timeToX(v, 10 * MIN)).toBeCloseTo((390 * 0.2) / 1.4, 3);
    expect(timeToX(v, 12 * MIN)).toBeCloseTo(390 - (390 * 0.2) / 1.4, 3);
  });
  it("녹음 전체보다 긴 fit은 전체 보기에서 멈춘다", () => {
    const d = MIN;
    const v = fitRange(390, 0, MIN, 0.2, d);
    expect(v.msPerPx).toBeCloseTo(widestMsPerPx(d, 390));
  });
  it("0 길이 구간도 터지지 않는다", () => {
    const v = fitRange(390, 5000, 5000, 0.2, MIN);
    expectInvariants(v, MIN);
  });
});

describe("keepCenterOnResize", () => {
  it("폭이 바뀌어도 중앙 시각이 같다", () => {
    const d = HOUR;
    const v = { startMs: 10 * MIN, msPerPx: 100, widthPx: 390 };
    const center = v.startMs + (v.widthPx * v.msPerPx) / 2;
    const out = keepCenterOnResize(v, 768, d);
    expectInvariants(out, d);
    expect(out.widthPx).toBe(768);
    expect(out.startMs + (out.widthPx * out.msPerPx) / 2).toBeCloseTo(center, 3);
  });
});

describe("랜덤 불변식 (2000회)", () => {
  it("pan·zoom·fit을 섞어도 viewport가 녹음 범위 안에 있고 focal이 미끄러지지 않는다", () => {
    const rnd = lcg(20260911);
    for (const d of DURATIONS) {
      for (const w of WIDTHS) {
        let v = full(d, w);
        for (let i = 0; i < 2000 / (DURATIONS.length * WIDTHS.length) + 1; i++) {
          const op = rnd();
          if (op < 0.4) {
            v = panViewport(v, (rnd() - 0.5) * 2 * w, d);
          } else if (op < 0.8) {
            const focalX = rnd() * w;
            const focalMs = xToTime(v, focalX);
            const scale = 0.25 + rnd() * 3.75;
            const next = zoomAtFocal(v, focalX, scale, d);
            // 경계에 걸려 start가 잘리지 않은 경우에만 focal 고정을 요구한다
            const unclamped = focalMs - focalX * next.msPerPx;
            if (Math.abs(unclamped - next.startMs) < 1e-6) expect(Math.abs(timeToX(next, focalMs) - focalX)).toBeLessThan(0.5);
            v = next;
          } else {
            const a = rnd() * d;
            const b = Math.min(d, a + rnd() * 5 * MIN);
            v = fitRange(w, a, b, 0.2, d);
          }
          expectInvariants(v, d);
          // 픽셀 누적이 아니라 절대 계산이므로 왕복 오차가 없다 (22-J)
          expect(xToTime(v, timeToX(v, d / 2))).toBeCloseTo(d / 2, 3);
        }
      }
    }
  });
});
