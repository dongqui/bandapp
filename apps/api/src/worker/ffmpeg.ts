import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PeakAccumulator } from "./peaks.js";

const execFileAsync = promisify(execFile);

// 멈춰버린 ffmpeg/ffprobe 프로세스가 heartbeat만 계속 갱신하며 워커를 영원히 붙잡지 않도록 상한을 둔다.
const FFPROBE_TIMEOUT_MS = 60_000;
const FFMPEG_CUT_TIMEOUT_MS = 10 * 60_000;
const FFMPEG_PEAKS_TIMEOUT_MS = 10 * 60_000;
/** 피크용 디코드 샘플레이트 — 파형 모양만 필요하니 낮춰서 디코드 시간과 파이프 양을 줄인다 */
const PEAKS_SAMPLE_RATE = 8000;

export interface FfmpegRunner {
  probeDurationMs(input: string): Promise<number>;
  /** 재인코딩 없이(`-c copy`) 구간을 잘라낸다. AAC는 프레임이 독립적이라 ~23ms 정밀도로 충분하다. */
  cut(input: string, startMs: number, endMs: number, output: string): Promise<void>;
  /** 전체를 모노 s16le로 디코드해 초당 peaksPerSec개의 피크(0~255)를 돌려준다 (2026-09-10 스펙 결정 3). */
  peaks(input: string, peaksPerSec: number): Promise<Uint8Array>;
}

export class ExecFfmpegRunner implements FfmpegRunner {
  constructor(
    private readonly ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg",
    private readonly ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe",
  ) {}

  async probeDurationMs(input: string): Promise<number> {
    const { stdout } = await execFileAsync(
      this.ffprobeBin,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input],
      { timeout: FFPROBE_TIMEOUT_MS },
    );
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe returned no duration for ${input}: ${stdout}`);
    return Math.round(seconds * 1000);
  }

  async cut(input: string, startMs: number, endMs: number, output: string): Promise<void> {
    // -ss를 -i 앞에 두면 입력 seek이라 빠르고, 길이는 -t(구간 길이)로 준다.
    // -to는 -ss 뒤에서 기준점이 달라져 헷갈리므로 쓰지 않는다.
    await execFileAsync(
      this.ffmpegBin,
      [
        "-v", "error",
        "-y",
        "-ss", (startMs / 1000).toFixed(3),
        "-t", ((endMs - startMs) / 1000).toFixed(3),
        "-i", input,
        "-vn",
        "-c", "copy",
        "-movflags", "+faststart",
        output,
      ],
      { timeout: FFMPEG_CUT_TIMEOUT_MS },
    );
  }

  peaks(input: string, peaksPerSec: number): Promise<Uint8Array> {
    const acc = new PeakAccumulator(Math.max(1, Math.round(PEAKS_SAMPLE_RATE / peaksPerSec)));
    return new Promise((resolve, reject) => {
      // stdout으로 raw PCM을 흘려 파일을 만들지 않는다 — 3시간이면 8kHz s16le로 86MB라 디스크에 두지 않는다.
      const child = spawn(
        this.ffmpegBin,
        ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", String(PEAKS_SAMPLE_RATE), "-f", "s16le", "-"],
        { stdio: ["ignore", "pipe", "pipe"], timeout: FFMPEG_PEAKS_TIMEOUT_MS },
      );
      let stderr = "";
      // data 핸들러 안에서 던지면 이벤트 이미터라 프로미스를 거부하지 못하고 uncaught exception으로
      // 새 나가 워커 프로세스 전체가 죽는다 — 자식 프로세스를 정리하고 직접 reject해야 한다 (스펙 결정 5).
      const fail = (err: Error) => { child.kill("SIGKILL"); reject(err); };
      child.stdout.on("data", (chunk: Buffer) => { try { acc.push(chunk); } catch (e) { fail(e as Error); } });
      child.stdout.on("error", fail);
      child.stderr.on("error", fail);
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) resolve(acc.finish());
        else reject(new Error(`ffmpeg peaks failed for ${input} (code ${code}, signal ${signal}): ${stderr.trim()}`));
      });
    });
  }
}
