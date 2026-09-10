import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecFfmpegRunner } from "./ffmpeg.js";

/**
 * 지금까지 가짜 ffmpeg로만 테스트했다 — 실제 ffmpeg 바이너리로 peaks()가 진짜 PCM을 만들어내는지는
 * 검증된 적이 없었다. ffmpeg이 없는 환경(CI 이미지 등)에서는 건너뛴다.
 */
const ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg";
const hasFfmpeg = spawnSync(ffmpegBin, ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("ExecFfmpegRunner.peaks (real ffmpeg)", () => {
  let dir: string;
  let tonePath: string;

  // 이 ffmpeg 빌드의 lavfi sine 소스는 기본 진폭이 풀스케일의 1/8뿐이라 그대로 쓰면 피크가 33/255에
  // 그친다 — 실제 녹음과 비슷하게 거의 풀스케일이 되도록 volume=7로 증폭해서 픽스처를 만든다
  // (production 코드는 이 볼륨 필터를 거치지 않는다 — 테스트용 입력 파일을 만들 때만 쓴다).
  const SINE_ARGS = ["-af", "volume=7", "-ac", "1", "-ar", "44100"];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ffmpeg-peaks-"));
    // 실제 녹음처럼 AAC/m4a로 먼저 시도하고, 인코더가 없는 환경이면 wav로 떨어진다.
    tonePath = join(dir, "tone.m4a");
    const m4a = spawnSync(ffmpegBin, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", ...SINE_ARGS, tonePath]);
    if (m4a.status !== 0) {
      tonePath = join(dir, "tone.wav");
      spawnSync(ffmpegBin, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", ...SINE_ARGS, tonePath]);
    }
    console.log(`ffmpeg.spec: encoded tone as ${tonePath.endsWith(".m4a") ? "m4a (AAC)" : "wav (fallback)"}`);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("decodes a 2s 440Hz tone into ~100 peaks in range, near full scale", async () => {
    const peaks = await new ExecFfmpegRunner().peaks(tonePath, 50);
    console.log(`ffmpeg.spec: length=${peaks.length} max=${Math.max(...peaks)}`);
    expect(peaks.length).toBeGreaterThanOrEqual(95);
    expect(peaks.length).toBeLessThanOrEqual(105);
    expect(Array.from(peaks).every((p) => p >= 0 && p <= 255)).toBe(true);
    expect(Math.max(...peaks)).toBeGreaterThanOrEqual(100);
  });

  it("distinguishes silence from tone (1s silence + 1s tone)", async () => {
    const silence = join(dir, "half.m4a");
    spawnSync(ffmpegBin, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "aevalsrc=0:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-filter_complex", "[1:a]volume=7[tone];[0:a][tone]concat=n=2:v=0:a=1[out]", "-map", "[out]",
      "-ac", "1", "-ar", "44100", silence,
    ]);
    const peaks = Array.from(await new ExecFfmpegRunner().peaks(silence, 50));
    const first = peaks.slice(0, 40);
    const last = peaks.slice(-40);
    console.log(`ffmpeg.spec: silence-half max=${Math.max(...first)} tone-half min=${Math.min(...last)}`);
    expect(first.every((p) => p < 10)).toBe(true);
    expect(last.every((p) => p > 100)).toBe(true);
  });

  it("rejects for a nonexistent input file", async () => {
    await expect(new ExecFfmpegRunner().peaks(join(dir, "does-not-exist.m4a"), 50)).rejects.toThrow();
  });
});
