import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FfmpegRunner {
  probeDurationMs(input: string): Promise<number>;
  /** 재인코딩 없이(`-c copy`) 구간을 잘라낸다. AAC는 프레임이 독립적이라 ~23ms 정밀도로 충분하다. */
  cut(input: string, startMs: number, endMs: number, output: string): Promise<void>;
}

export class ExecFfmpegRunner implements FfmpegRunner {
  constructor(
    private readonly ffmpegBin = process.env.FFMPEG_BIN ?? "ffmpeg",
    private readonly ffprobeBin = process.env.FFPROBE_BIN ?? "ffprobe",
  ) {}

  async probeDurationMs(input: string): Promise<number> {
    const { stdout } = await execFileAsync(this.ffprobeBin, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      input,
    ]);
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe returned no duration for ${input}: ${stdout}`);
    return Math.round(seconds * 1000);
  }

  async cut(input: string, startMs: number, endMs: number, output: string): Promise<void> {
    // -ss를 -i 앞에 두면 입력 seek이라 빠르고, 길이는 -t(구간 길이)로 준다.
    // -to는 -ss 뒤에서 기준점이 달라져 헷갈리므로 쓰지 않는다.
    await execFileAsync(this.ffmpegBin, [
      "-v", "error",
      "-y",
      "-ss", (startMs / 1000).toFixed(3),
      "-t", ((endMs - startMs) / 1000).toFixed(3),
      "-i", input,
      "-vn",
      "-c", "copy",
      "-movflags", "+faststart",
      output,
    ]);
  }
}
