import { PEAKS_FILE_HEADER_BYTES, PEAKS_FILE_MAGIC, PEAKS_FILE_VERSION } from "@bandapp/types";

export interface PeaksFile {
  peaksPerSec: number;
  peaks: Uint8Array;
}

/** peaks.bin 파서 (2026-09-11 스펙 결정 4). 형식이 다르면 throw — 화면은 128버킷 폴백으로 내려간다 */
export function parsePeaksFile(buf: ArrayBuffer): PeaksFile {
  if (buf.byteLength < PEAKS_FILE_HEADER_BYTES) throw new Error("peaks file too short");
  const bytes = new Uint8Array(buf);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== PEAKS_FILE_MAGIC) throw new Error(`bad peaks magic: ${magic}`);
  const version = bytes[4]!;
  if (version !== PEAKS_FILE_VERSION) throw new Error(`unsupported peaks version: ${version}`);
  const peaksPerSec = bytes[5]! | (bytes[6]! << 8);
  if (peaksPerSec === 0) throw new Error("peaksPerSec is 0");
  return { peaksPerSec, peaks: bytes.slice(PEAKS_FILE_HEADER_BYTES) };
}
