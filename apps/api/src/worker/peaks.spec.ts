import { PEAKS_FILE_HEADER_BYTES, PEAKS_FILE_MAGIC, PEAKS_FILE_VERSION } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { decodePeaksFile, encodePeaksFile, PeakAccumulator, slicePeaks } from "./peaks.js";

/** s16le 버퍼 — ffmpeg stdout과 같은 바이트 순서 */
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe("PeakAccumulator", () => {
  it("창마다 max|s|를 0~255로 환산하고 마지막 자투리 창도 포함한다", () => {
    const acc = new PeakAccumulator(2);
    acc.push(pcm([1000, -2000, 3000]));
    // 2000/32767*255 = 15.56 → 16, 3000 → 23.35 → 23
    expect(Array.from(acc.finish())).toEqual([16, 23]);
  });

  it("청크 경계에 걸린 홀수 바이트를 이월한다", () => {
    const acc = new PeakAccumulator(1);
    const bytes = pcm([32767, -32768]);
    acc.push(bytes.subarray(0, 1));
    acc.push(bytes.subarray(1, 3));
    acc.push(bytes.subarray(3));
    expect(Array.from(acc.finish())).toEqual([255, 255]);
  });

  it("아무것도 안 넣으면 빈 배열", () => {
    expect(new PeakAccumulator(4).finish()).toHaveLength(0);
  });

  it("6만 개 넘는 창도 쌓는다 (내부 버퍼 확장)", () => {
    const acc = new PeakAccumulator(1);
    acc.push(pcm(Array.from({ length: 70_000 }, () => 32767)));
    const out = acc.finish();
    expect(out).toHaveLength(70_000);
    expect(out[69_999]).toBe(255);
  });

  it("samplesPerPeak가 양의 정수가 아니면 throw", () => {
    expect(() => new PeakAccumulator(0)).toThrow();
    expect(() => new PeakAccumulator(1.5)).toThrow();
  });
});

describe("slicePeaks", () => {
  it("구간을 buckets개 창으로 나눠 창 안 max를 취하고 최댓값을 255로 정규화한다", () => {
    const hires = Uint8Array.from([10, 20, 30, 40]);
    // 초당 1개, 0~4초 → [max(10,20), max(30,40)] = [20,40] → [128, 255]
    expect(slicePeaks(hires, 1, 0, 4000, 2)).toEqual([128, 255]);
  });

  it("구간이 buckets보다 짧으면 같은 값이 반복된다", () => {
    const hires = Uint8Array.from([100, 200]);
    expect(slicePeaks(hires, 1, 0, 2000, 4)).toEqual([128, 128, 255, 255]);
  });

  it("범위를 배열 길이로 clamp한다", () => {
    const hires = Uint8Array.from([50, 100]);
    // 끝이 배열 밖 → 있는 만큼만
    expect(slicePeaks(hires, 1, 1000, 9000, 2)).toEqual([255, 255]);
    // 시작이 배열 밖 → 전부 0
    expect(slicePeaks(hires, 1, 5000, 9000, 3)).toEqual([0, 0, 0]);
  });

  it("무음은 정규화하지 않고 0을 유지하고, 빈 배열은 전부 0", () => {
    expect(slicePeaks(Uint8Array.from([0, 0, 0]), 1, 0, 3000, 3)).toEqual([0, 0, 0]);
    expect(slicePeaks(new Uint8Array(0), 50, 0, 1000, 4)).toEqual([0, 0, 0, 0]);
  });

  it("초당 50개 기준으로 ms를 인덱스로 바꾼다", () => {
    // 0~1초는 0, 1~2초는 255
    const hires = Uint8Array.from([...Array<number>(50).fill(0), ...Array<number>(50).fill(255)]);
    expect(slicePeaks(hires, 50, 0, 2000, 2)).toEqual([0, 255]);
    expect(slicePeaks(hires, 50, 1000, 2000, 2)).toEqual([255, 255]);
  });
});

describe("encodePeaksFile", () => {
  it("8바이트 헤더(magic, version, peaksPerSec u16 LE, reserved) 뒤에 피크 바이트를 그대로 붙인다", () => {
    const buf = encodePeaksFile(Uint8Array.from([0, 128, 255]), 50);
    expect(buf.length).toBe(PEAKS_FILE_HEADER_BYTES + 3);
    expect(buf.subarray(0, 4).toString("ascii")).toBe(PEAKS_FILE_MAGIC);
    expect(buf.readUInt8(4)).toBe(PEAKS_FILE_VERSION);
    expect(buf.readUInt16LE(5)).toBe(50);
    expect(buf.readUInt8(7)).toBe(0);
    expect(Array.from(buf.subarray(8))).toEqual([0, 128, 255]);
  });

  it("빈 피크는 헤더만 있는 파일이 된다", () => {
    expect(encodePeaksFile(new Uint8Array(0), 50).length).toBe(PEAKS_FILE_HEADER_BYTES);
  });

  it("peaksPerSec가 1..65535 정수가 아니면 throw", () => {
    expect(() => encodePeaksFile(new Uint8Array(0), 0)).toThrow();
    expect(() => encodePeaksFile(new Uint8Array(0), 70_000)).toThrow();
    expect(() => encodePeaksFile(new Uint8Array(0), 1.5)).toThrow();
  });
});

describe("decodePeaksFile", () => {
  it("encodePeaksFile의 역이다", () => {
    const hires = Uint8Array.from([0, 7, 255, 128]);
    const out = decodePeaksFile(encodePeaksFile(hires, 50));
    expect(out.peaksPerSec).toBe(50);
    expect(Array.from(out.hires)).toEqual([0, 7, 255, 128]);
  });
  it("magic·version·peaksPerSec가 틀리면 throw", () => {
    const ok = encodePeaksFile(new Uint8Array(0), 50);
    const badMagic = Buffer.from(ok);
    badMagic.write("XXXX", 0, "ascii");
    expect(() => decodePeaksFile(badMagic)).toThrow(/magic/);
    const badVersion = Buffer.from(ok);
    badVersion.writeUInt8(9, 4);
    expect(() => decodePeaksFile(badVersion)).toThrow(/version/);
    const zero = Buffer.from(ok);
    zero.writeUInt16LE(0, 5);
    expect(() => decodePeaksFile(zero)).toThrow(/peaksPerSec/);
    expect(() => decodePeaksFile(Buffer.alloc(3))).toThrow(/short/);
  });
});
