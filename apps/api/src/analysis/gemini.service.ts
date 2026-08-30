import { extname } from "node:path";
import { Logger, type Provider } from "@nestjs/common";
import { GoogleGenAI, Type, createPartFromUri, createUserContent } from "@google/genai";
import type { TakeCandidate } from "@bandapp/types";

const MIME_BY_EXT: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mp3",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

export function audioMimeType(filePath: string): string {
  const mime = MIME_BY_EXT[extname(filePath).toLowerCase()];
  if (!mime) {
    throw new Error(`unsupported audio extension: ${filePath}`);
  }
  return mime;
}

const TAKE_TYPES = new Set(["PERFORMANCE", "PARTIAL_PRACTICE"]);

export function parseTakes(text: string): TakeCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`gemini response is not valid JSON: ${text.slice(0, 200)}`);
  }
  const takes = (parsed as { takes?: unknown }).takes;
  if (!Array.isArray(takes)) {
    throw new Error("gemini response has no takes array");
  }
  return takes.map((take, i) => {
    const t = take as Record<string, unknown>;
    if (
      typeof t.startMs !== "number" ||
      typeof t.endMs !== "number" ||
      t.startMs >= t.endMs ||
      typeof t.confidence !== "number" ||
      typeof t.type !== "string" ||
      !TAKE_TYPES.has(t.type)
    ) {
      throw new Error(`invalid take candidate at index ${i}: ${JSON.stringify(take)}`);
    }
    return {
      startMs: t.startMs,
      endMs: t.endMs,
      type: t.type as TakeCandidate["type"],
      confidence: t.confidence,
    };
  });
}

// 테스트에서 mock으로 대체하는 최소 SDK 표면.
export interface GenAiClient {
  files: {
    upload(params: { file: string; config?: { mimeType?: string } }): Promise<{
      name?: string;
      uri?: string;
      mimeType?: string;
      state?: string;
    }>;
    get(params: { name: string }): Promise<{ state?: string; uri?: string; mimeType?: string }>;
  };
  models: {
    generateContent(params: unknown): Promise<{ text?: string }>;
  };
}

function defaultClientFactory(): GenAiClient {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  return new GoogleGenAI({ apiKey }) as unknown as GenAiClient;
}

const TAKES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    takes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startMs: { type: Type.NUMBER },
          endMs: { type: Type.NUMBER },
          type: { type: Type.STRING, enum: ["PERFORMANCE", "PARTIAL_PRACTICE"] },
          confidence: { type: Type.NUMBER },
        },
        required: ["startMs", "endMs", "type", "confidence"],
      },
    },
  },
  required: ["takes"],
};

const ANALYSIS_PROMPT = `
Analyze this band rehearsal recording.

Find meaningful band performance takes.

Ignore:
- casual conversation
- tuning
- isolated instrument checking
- short accidental playing

Return performance regions with start and end timestamps in milliseconds.
Use type PERFORMANCE for full takes and PARTIAL_PRACTICE for partial run-throughs.
`.trim();

// 주의: 생성자 파라미터(함수/숫자)는 Nest가 주입할 수 없으므로 @Injectable을 붙이지 않고
// 모듈에서는 아래 geminiServiceProvider(useFactory)로 등록한다.
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);

  constructor(
    private readonly createClient: () => GenAiClient = defaultClientFactory,
    private readonly pollIntervalMs = 2000,
  ) {}

  async analyzeAudio(filePath: string): Promise<TakeCandidate[]> {
    const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 300000);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`gemini analysis timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([this.doAnalyze(filePath, Date.now() + timeoutMs), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async doAnalyze(filePath: string, deadline: number): Promise<TakeCandidate[]> {
    const client = this.createClient();
    const model = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

    const uploaded = await client.files.upload({
      file: filePath,
      config: { mimeType: audioMimeType(filePath) },
    });
    const active = await this.waitForActive(client, uploaded, deadline);

    this.logger.log(`analyzing ${filePath} with ${model}`);
    const response = await client.models.generateContent({
      model,
      contents: createUserContent([
        ANALYSIS_PROMPT,
        createPartFromUri(active.uri as string, active.mimeType as string),
      ]),
      config: {
        responseMimeType: "application/json",
        responseSchema: TAKES_SCHEMA,
      },
    });
    if (!response.text) {
      throw new Error("gemini returned an empty response");
    }
    return parseTakes(response.text);
  }

  private async waitForActive(
    client: GenAiClient,
    uploaded: { name?: string; uri?: string; mimeType?: string; state?: string },
    deadline: number,
  ): Promise<{ uri?: string; mimeType?: string }> {
    let file: { state?: string; uri?: string; mimeType?: string } = uploaded;
    while (file.state === "PROCESSING") {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for gemini file to become ACTIVE");
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      file = await client.files.get({ name: uploaded.name as string });
    }
    if (file.state === "FAILED") {
      throw new Error("gemini file processing failed");
    }
    return file;
  }
}

/** 모듈 등록용 provider — Nest가 생성자 파라미터를 주입하려 들지 않게 useFactory로 감싼다. */
export const geminiServiceProvider: Provider = {
  provide: GeminiService,
  useFactory: () => new GeminiService(),
};
