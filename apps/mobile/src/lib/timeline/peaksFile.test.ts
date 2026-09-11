import { PEAKS_FILE_HEADER_BYTES } from "@bandapp/types";
import { describe, expect, it } from "vitest";
import { parsePeaksFile } from "./peaksFile";

function file(magic: string, version: number, peaksPerSec: number, body: number[]): ArrayBuffer {
  const bytes = new Uint8Array(PEAKS_FILE_HEADER_BYTES + body.length);
  for (let i = 0; i < 4; i++) bytes[i] = magic.charCodeAt(i);
  bytes[4] = version;
  bytes[5] = peaksPerSec & 0xff;
  bytes[6] = peaksPerSec >> 8;
  bytes[7] = 0;
  bytes.set(body, PEAKS_FILE_HEADER_BYTES);
  return bytes.buffer;
}

describe("parsePeaksFile", () => {
  it("헤더를 읽고 본문을 돌려준다", () => {
    const out = parsePeaksFile(file("TNPK", 1, 50, [0, 128, 255]));
    expect(out.peaksPerSec).toBe(50);
    expect(Array.from(out.peaks)).toEqual([0, 128, 255]);
  });
  it("u16 LE — 300 peaks/s", () => {
    expect(parsePeaksFile(file("TNPK", 1, 300, [])).peaksPerSec).toBe(300);
  });
  it("magic·version이 다르거나 너무 짧으면 throw", () => {
    expect(() => parsePeaksFile(file("XXXX", 1, 50, []))).toThrow(/magic/);
    expect(() => parsePeaksFile(file("TNPK", 2, 50, []))).toThrow(/version/);
    expect(() => parsePeaksFile(new ArrayBuffer(4))).toThrow(/short/);
    expect(() => parsePeaksFile(file("TNPK", 1, 0, []))).toThrow(/peaksPerSec/);
  });
});
