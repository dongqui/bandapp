/**
 * Windows에서 서버 전 구간을 실제 R2·Gemini로 검증한다 (스펙 "검증 스크립트").
 *
 *   UPLOAD_FILE=poc/data/raw_sessions/IMG_2811.m4a API_URL=http://localhost:3001 DEV_LOGIN_SECRET=... \
 *     pnpm --filter @bandapp/api upload-session
 *
 * dev 로그인 → 밴드 확보 → multipart 업로드 → ready/failed까지 폴링 → takes 출력 → 첫 take를 내려받아 ffprobe.
 */
import { execFile } from "node:child_process";
import { open, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { HttpApiClient, uploadRecording, type TokenStorage } from "@bandapp/api-client";
import type { AuthTokens } from "@bandapp/types";

const execFileAsync = promisify(execFile);

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function memoryTokens(): TokenStorage {
  let tokens: AuthTokens | null = null;
  return {
    getAccessToken: async () => tokens?.accessToken ?? null,
    getRefreshToken: async () => tokens?.refreshToken ?? null,
    setTokens: async (t) => {
      tokens = t;
    },
    clear: async () => {
      tokens = null;
    },
  };
}

async function main(): Promise<void> {
  const apiUrl = env("API_URL", "http://localhost:3001");
  const file = resolve(env("UPLOAD_FILE"));
  const secret = env("DEV_LOGIN_SECRET");
  const tokens = memoryTokens();
  const client = new HttpApiClient({ baseUrl: apiUrl, tokens });

  const loginRes = await fetch(`${apiUrl}/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, displayName: "Dongjin (script)" }),
  });
  if (!loginRes.ok) throw new Error(`dev login failed: ${loginRes.status} ${await loginRes.text()}`);
  const login = (await loginRes.json()) as AuthTokens;
  await tokens.setTokens({ accessToken: login.accessToken, refreshToken: login.refreshToken });

  const bands = await client.bands.list();
  const band = bands[0] ?? (await client.bands.create("Script Band"));
  console.log(`band ${band.id} (${band.name})`);

  const { size } = await stat(file);
  const handle = await open(file, "r");
  try {
    const started = Date.now();
    const session = await uploadRecording({
      client,
      bandId: band.id,
      input: { startedAt: new Date().toISOString(), sizeBytes: size, contentType: "audio/mp4", source: "import" },
      source: {
        sizeBytes: size,
        readPart: async ({ start, end }) => {
          const buf = Buffer.alloc(end - start);
          await handle.read(buf, 0, end - start, start);
          return new Blob([buf]);
        },
      },
      onProgress: (p) => process.stdout.write(`\rupload ${Math.round((p.uploadedBytes / p.totalBytes) * 100)}%   `),
    });
    console.log(`\nuploaded in ${((Date.now() - started) / 1000).toFixed(1)}s → session ${session.id} ${session.status}`);

    let current = session;
    const analysisStarted = Date.now();
    while (current.status === "analyzing" || current.status === "uploading") {
      await new Promise((r) => setTimeout(r, 5000));
      current = await client.sessions.get(session.id);
      process.stdout.write(`\ranalyzing… ${Math.round((Date.now() - analysisStarted) / 1000)}s   `);
    }
    console.log(`\nsession ${current.status}: ${current.takeCount} takes, ${current.durationSec}s`);
    if (current.status === "failed") {
      throw new Error("analysis failed — check the worker logs (docker compose logs worker)");
    }

    const takes = await client.takes.list(session.id);
    for (const t of takes) {
      console.log(`  #${t.index + 1} ${t.name}  ${fmt(t.startMs)} → ${fmt(t.endMs)}  (${t.durationSec}s, ${t.type})`);
    }
    if (takes[0]) {
      const { url } = await client.takes.audioUrl(takes[0].id);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`take download failed: ${res.status}`);
      const out = join(tmpdir(), `take-${takes[0].id}.m4a`);
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
      console.log(`first take downloaded to ${out}, ffprobe duration ${Number(stdout).toFixed(1)}s`);
    }
  } finally {
    await handle.close();
  }
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
