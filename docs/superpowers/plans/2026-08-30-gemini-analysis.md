# Gemini 오디오 분석 연동 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker가 분석 job의 `audioPath` 오디오를 Gemini로 분석해 TakeCandidate JSON을 로그로 출력한다 (API→SQS→Worker→Gemini 경로 검증).

**Architecture:** `@google/genai` SDK를 GeminiService로 감싸고(파일 업로드→ACTIVE 폴링→structured output 분석→검증), worker consumer가 job에 `audioPath`가 있을 때만 호출한다. 결과는 로그 출력만 — DB/R2는 다음 단계.

**Tech Stack:** NestJS 12 (ESM), @google/genai, vitest, Docker Compose (검증).

**Spec:** `docs/superpowers/specs/2026-08-30-gemini-analysis-design.md`

## Global Constraints

- `apps/api`는 ESM: 상대 import에 반드시 `.js` 접미사. 테스트는 vitest globals, `*.spec.ts`, 직접 인스턴스화 스타일.
- env: `GEMINI_API_KEY`(호출 시점 검증), `GEMINI_MODEL`(기본 `gemini-3.6-flash`), `GEMINI_TIMEOUT_MS`(기본 300000). 키를 코드/커밋에 넣지 않는다.
- TakeCandidate 스키마(스펙 §1) 고정: `startMs`, `endMs`, `type: "PERFORMANCE" | "PARTIAL_PRACTICE"`, `confidence`(0..1).
- 범위 제외: DB 저장, R2, Gemini 재시도/업로드 파일 삭제 lifecycle, Python 워커 Gemini, 실시간 분석.
- 실패 정책: 분석 throw → 메시지 미삭제(재전달). 단 `audioPath` 있는데 `GEMINI_API_KEY` 미설정이면 consumer가 호출 전에 확인해 경고 로그 후 정상 삭제.
- 레거시 `@google/generative-ai` 금지 — `@google/genai`만 사용.
- 커밋 관례: `feat(api): ...` / `feat(types): ...` + 트레일러 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- 주의: 설치된 `@google/genai`의 실제 API가 이 계획의 코드와 다르면(SDK 메이저 변경 등) **계획을 어기지 말고 DONE_WITH_CONCERNS로 보고**하되, 차이가 명백한 이름 변경 수준이면 SDK 타입 정의에 맞춰 조정하고 보고서에 명시한다.

---

### Task 1: 분석 결과 타입 + SDK 설치

**Files:**
- Create: `packages/types/src/analysis.ts`
- Modify: `packages/types/src/index.ts` (re-export 추가)
- Modify: `apps/api/package.json`, `pnpm-lock.yaml` (의존성 추가로 자동 변경)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `TakeCandidateType = "PERFORMANCE" | "PARTIAL_PRACTICE"`
  - `TakeCandidate { startMs: number; endMs: number; type: TakeCandidateType; confidence: number }`
  - `RecordingAnalysisResult { recordingId: string; model: string; takes: TakeCandidate[] }`
  - `@google/genai` 패키지 (apps/api dependency)

- [ ] **Step 1: 타입 파일 작성**

`packages/types/src/analysis.ts`:

```ts
export type TakeCandidateType = "PERFORMANCE" | "PARTIAL_PRACTICE";

/** AI 분석이 추출한 연주 구간 후보. 사용자가 수정 가능한 초안이다. */
export interface TakeCandidate {
  startMs: number;
  endMs: number;
  type: TakeCandidateType;
  /** 0..1 */
  confidence: number;
}

export interface RecordingAnalysisResult {
  recordingId: string;
  model: string;
  takes: TakeCandidate[];
}
```

`packages/types/src/index.ts`에 한 줄 추가 (기존 export들 유지):

```ts
export * from "./analysis.js";
```

주의: index.ts의 기존 export 문들이 `./xxx.js` 접미사를 쓰는지 확인하고 같은 스타일을 따른다 (`.js` 없이 `./analysis`라면 그 스타일로).

- [ ] **Step 2: 빌드 확인**

Run: `pnpm --filter @bandapp/types build`
Expected: 성공, `packages/types/dist/analysis.d.ts` 생성.

- [ ] **Step 3: SDK 설치**

```bash
pnpm --filter @bandapp/api add @google/genai
```

- [ ] **Step 4: 전체 테스트 + 커밋**

```bash
pnpm test
git add packages/types apps/api/package.json pnpm-lock.yaml
git commit -m "feat(types): add take candidate analysis types and genai sdk"
```

---

### Task 2: GeminiService

**Files:**
- Create: `apps/api/src/analysis/gemini.service.ts`
- Create: `apps/api/src/analysis/gemini.service.spec.ts`

**Interfaces:**
- Consumes: `TakeCandidate` (`@bandapp/types`, Task 1)
- Produces:
  - `GeminiService.analyzeAudio(filePath: string): Promise<TakeCandidate[]>`
  - `parseTakes(text: string): TakeCandidate[]` — 순수 함수, 검증 실패 시 throw
  - `audioMimeType(filePath: string): string` — 순수 함수, 미지원 확장자 throw
  - `GenAiClient` 인터페이스 (테스트 mock용 최소 표면)
  - 생성자: `new GeminiService(createClient?: () => GenAiClient, pollIntervalMs = 2000)` — 테스트에서 mock 주입

- [ ] **Step 1: 순수 함수 실패 테스트 작성**

`apps/api/src/analysis/gemini.service.spec.ts` (1차분):

```ts
import { audioMimeType, parseTakes } from "./gemini.service.js";

describe("audioMimeType", () => {
  it("maps known audio extensions", () => {
    expect(audioMimeType("poc/data/a.wav")).toBe("audio/wav");
    expect(audioMimeType("x.mp3")).toBe("audio/mp3");
    expect(audioMimeType("x.m4a")).toBe("audio/mp4");
  });

  it("throws on unsupported extensions", () => {
    expect(() => audioMimeType("notes.txt")).toThrow("unsupported audio extension");
  });
});

describe("parseTakes", () => {
  it("parses a valid takes payload", () => {
    const text = JSON.stringify({
      takes: [{ startMs: 1000, endMs: 5000, type: "PERFORMANCE", confidence: 0.93 }],
    });
    expect(parseTakes(text)).toEqual([
      { startMs: 1000, endMs: 5000, type: "PERFORMANCE", confidence: 0.93 },
    ]);
  });

  it("accepts an empty takes array", () => {
    expect(parseTakes(JSON.stringify({ takes: [] }))).toEqual([]);
  });

  it.each([
    ["not json", "not-json"],
    ["missing takes", JSON.stringify({})],
    ["startMs >= endMs", JSON.stringify({ takes: [{ startMs: 5, endMs: 5, type: "PERFORMANCE", confidence: 0.5 }] })],
    ["bad type enum", JSON.stringify({ takes: [{ startMs: 0, endMs: 5, type: "JAM", confidence: 0.5 }] })],
    ["non-number confidence", JSON.stringify({ takes: [{ startMs: 0, endMs: 5, type: "PERFORMANCE", confidence: "high" }] })],
  ])("throws on invalid payload: %s", (_label, text) => {
    expect(() => parseTakes(text)).toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/gemini.service.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 순수 함수 + 서비스 골격 구현**

`apps/api/src/analysis/gemini.service.ts`:

```ts
import { extname } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
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

@Injectable()
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
```

- [ ] **Step 4: 순수 함수 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/gemini.service.spec.ts`
Expected: PASS (순수 함수 테스트 전부)

- [ ] **Step 5: analyzeAudio 흐름 테스트 추가**

같은 spec 파일에 추가:

```ts
import { GeminiService, type GenAiClient } from "./gemini.service.js";

describe("GeminiService.analyzeAudio", () => {
  const validText = JSON.stringify({
    takes: [{ startMs: 0, endMs: 4000, type: "PERFORMANCE", confidence: 0.9 }],
  });

  function makeClient(overrides: Partial<Record<string, unknown>> = {}): GenAiClient {
    return {
      files: {
        upload: vi.fn().mockResolvedValue({
          name: "files/abc",
          uri: "https://files/abc",
          mimeType: "audio/wav",
          state: "ACTIVE",
          ...(overrides.uploadResult as object),
        }),
        get: (overrides.get as GenAiClient["files"]["get"]) ?? vi.fn(),
      },
      models: {
        generateContent:
          (overrides.generateContent as GenAiClient["models"]["generateContent"]) ??
          vi.fn().mockResolvedValue({ text: validText }),
      },
    };
  }

  beforeEach(() => {
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_TIMEOUT_MS;
  });

  it("uploads the file and returns parsed takes", async () => {
    const client = makeClient();
    const service = new GeminiService(() => client, 1);

    const takes = await service.analyzeAudio("poc/data/test.wav");

    expect(client.files.upload).toHaveBeenCalledWith({
      file: "poc/data/test.wav",
      config: { mimeType: "audio/wav" },
    });
    expect(takes).toEqual([{ startMs: 0, endMs: 4000, type: "PERFORMANCE", confidence: 0.9 }]);
  });

  it("polls until the uploaded file becomes ACTIVE", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ state: "PROCESSING" })
      .mockResolvedValueOnce({ state: "ACTIVE", uri: "https://files/abc", mimeType: "audio/wav" });
    const client = makeClient({ uploadResult: { state: "PROCESSING" }, get });
    const service = new GeminiService(() => client, 1);

    await service.analyzeAudio("a.wav");

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("throws when file processing fails", async () => {
    const get = vi.fn().mockResolvedValue({ state: "FAILED" });
    const client = makeClient({ uploadResult: { state: "PROCESSING" }, get });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeAudio("a.wav")).rejects.toThrow("processing failed");
  });

  it("throws when the response is empty", async () => {
    const client = makeClient({ generateContent: vi.fn().mockResolvedValue({ text: undefined }) });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeAudio("a.wav")).rejects.toThrow("empty response");
  });

  it("throws without calling the SDK when GEMINI_API_KEY is missing (default factory)", async () => {
    delete process.env.GEMINI_API_KEY;
    const service = new GeminiService();

    await expect(service.analyzeAudio("a.wav")).rejects.toThrow("GEMINI_API_KEY");
  });

  it("times out when the analysis exceeds GEMINI_TIMEOUT_MS", async () => {
    process.env.GEMINI_TIMEOUT_MS = "20";
    const client = makeClient({
      generateContent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeAudio("a.wav")).rejects.toThrow("timed out");
    delete process.env.GEMINI_TIMEOUT_MS;
  });
});
```

- [ ] **Step 6: 실패 확인 → 필요시 구현 보정 → 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/gemini.service.spec.ts`
Expected: PASS (전체). Step 3 구현이 이미 이 동작을 만족하므로, 실패하면 테스트가 아니라 구현을 스펙에 맞게 고친다.

- [ ] **Step 7: 전체 테스트 + 커밋**

```bash
pnpm --filter @bandapp/api test
git add apps/api/src/analysis/gemini.service.ts apps/api/src/analysis/gemini.service.spec.ts
git commit -m "feat(api): add gemini audio analysis service"
```

---

### Task 3: Job 확장 + consumer/producer 연동

**Files:**
- Modify: `apps/api/src/analysis/analysis.producer.ts` (audioPath 전달)
- Modify: `apps/api/src/analysis/analysis.producer.spec.ts`
- Modify: `apps/api/src/analysis/analysis.controller.ts` (body 수용)
- Modify: `apps/api/src/analysis/analysis.controller.spec.ts`
- Modify: `apps/api/src/analysis/analysis.module.ts` (GeminiService provider 추가)
- Modify: `apps/api/src/worker/analysis.consumer.ts` (Gemini 호출 분기)
- Modify: `apps/api/src/worker/analysis.consumer.spec.ts`
- Modify: `apps/api/src/worker/worker.module.ts` (GeminiService provider 추가)

**Interfaces:**
- Consumes: `GeminiService.analyzeAudio(filePath): Promise<TakeCandidate[]>` (Task 2), `RecordingAnalysisResult` (Task 1)
- Produces:
  - job 메시지 형식 `{ recordingId: string, audioPath?: string }`
  - `AnalysisProducer.enqueueAnalysis(recordingId: string, audioPath?: string): Promise<void>`
  - `POST /recordings/:id/analysis` body `{ audioPath?: string }` (선택)
  - consumer 생성자: `new AnalysisConsumer(sqs: SQSClient, gemini: GeminiService)`

- [ ] **Step 1: producer/controller 실패 테스트 추가**

`analysis.producer.spec.ts`에 추가:

```ts
  it("includes audioPath in the message body when provided", async () => {
    const send = vi.fn().mockResolvedValue({});
    const producer = new AnalysisProducer({ send } as unknown as SQSClient);

    await producer.enqueueAnalysis("rec_123", "poc/data/test.wav");

    const command = send.mock.calls[0][0] as SendMessageCommand;
    expect(JSON.parse(command.input.MessageBody!)).toEqual({
      recordingId: "rec_123",
      audioPath: "poc/data/test.wav",
    });
  });
```

`analysis.controller.spec.ts`의 기존 테스트를 교체/추가:

```ts
  it("passes audioPath from the body to the producer", async () => {
    const enqueueAnalysis = vi.fn().mockResolvedValue(undefined);
    const controller = new AnalysisController({
      enqueueAnalysis,
    } as unknown as AnalysisProducer);

    await controller.requestAnalysis("rec_123", { audioPath: "poc/data/test.wav" });

    expect(enqueueAnalysis).toHaveBeenCalledWith("rec_123", "poc/data/test.wav");
  });

  it("works without a body (audioPath undefined)", async () => {
    const enqueueAnalysis = vi.fn().mockResolvedValue(undefined);
    const controller = new AnalysisController({
      enqueueAnalysis,
    } as unknown as AnalysisProducer);

    const result = await controller.requestAnalysis("rec_123", undefined);

    expect(enqueueAnalysis).toHaveBeenCalledWith("rec_123", undefined);
    expect(result).toEqual({ recordingId: "rec_123", status: "QUEUED" });
  });
```

기존 테스트 중 `requestAnalysis("rec_123")` 한-인자 호출은 `requestAnalysis("rec_123", undefined)`로 맞춘다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis`
Expected: FAIL (새 시그니처 없음)

- [ ] **Step 3: producer/controller 구현**

`analysis.producer.ts`의 `enqueueAnalysis` 교체:

```ts
  async enqueueAnalysis(recordingId: string, audioPath?: string): Promise<void> {
    const queueUrl = process.env.SQS_ANALYSIS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("SQS_ANALYSIS_QUEUE_URL is not set");
    }
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(
          audioPath ? { recordingId, audioPath } : { recordingId },
        ),
      }),
    );
  }
```

`analysis.controller.ts` 교체:

```ts
import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { AnalysisProducer } from "./analysis.producer.js";

@Controller("recordings")
export class AnalysisController {
  constructor(private readonly producer: AnalysisProducer) {}

  @Post(":id/analysis")
  @HttpCode(202)
  async requestAnalysis(
    @Param("id") id: string,
    @Body() body?: { audioPath?: string },
  ): Promise<{ recordingId: string; status: "QUEUED" }> {
    await this.producer.enqueueAnalysis(id, body?.audioPath);
    return { recordingId: id, status: "QUEUED" };
  }
}
```

`analysis.module.ts`의 providers에 `GeminiService` 추가 (import 포함):

```ts
providers: [AnalysisProducer, GeminiService],
```

- [ ] **Step 4: analysis 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis`
Expected: PASS

- [ ] **Step 5: consumer 실패 테스트 추가**

`analysis.consumer.spec.ts` — `makeConsumer`를 교체하고 테스트 추가:

```ts
import type { GeminiService } from "../analysis/gemini.service.js";

  function makeConsumer(
    send: ReturnType<typeof vi.fn>,
    analyzeAudio: ReturnType<typeof vi.fn> = vi.fn(),
  ) {
    const gemini = { analyzeAudio } as unknown as GeminiService;
    return new AnalysisConsumer({ send } as unknown as SQSClient, gemini);
  }
```

(기존 테스트의 `makeConsumer(send)` 호출은 그대로 동작한다.)

추가 테스트:

```ts
  it("does not call gemini for messages without audioPath", async () => {
    const analyzeAudio = vi.fn();
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          { Body: JSON.stringify({ recordingId: "rec_1" }), ReceiptHandle: "rh-1" },
        ],
      })
      .mockResolvedValueOnce({});
    const consumer = makeConsumer(send, analyzeAudio);

    await consumer.pollOnce();

    expect(analyzeAudio).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2); // receive + delete
  });

  it("analyzes and deletes when audioPath is present and key is set", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const analyzeAudio = vi
      .fn()
      .mockResolvedValue([{ startMs: 0, endMs: 4000, type: "PERFORMANCE", confidence: 0.9 }]);
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          {
            Body: JSON.stringify({ recordingId: "rec_1", audioPath: "poc/data/a.wav" }),
            ReceiptHandle: "rh-1",
          },
        ],
      })
      .mockResolvedValueOnce({});
    const consumer = makeConsumer(send, analyzeAudio);

    await consumer.pollOnce();

    expect(analyzeAudio).toHaveBeenCalledWith("poc/data/a.wav");
    expect(send).toHaveBeenCalledTimes(2); // receive + delete
    delete process.env.GEMINI_API_KEY;
  });

  it("leaves the message when analysis fails", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const analyzeAudio = vi.fn().mockRejectedValue(new Error("gemini down"));
    const send = vi.fn().mockResolvedValueOnce({
      Messages: [
        {
          Body: JSON.stringify({ recordingId: "rec_1", audioPath: "poc/data/a.wav" }),
          ReceiptHandle: "rh-1",
        },
      ],
    });
    const consumer = makeConsumer(send, analyzeAudio);

    await consumer.pollOnce();

    expect(send).toHaveBeenCalledTimes(1); // receive만, delete 없음
    delete process.env.GEMINI_API_KEY;
  });

  it("skips analysis but deletes the message when GEMINI_API_KEY is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    const analyzeAudio = vi.fn();
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          {
            Body: JSON.stringify({ recordingId: "rec_1", audioPath: "poc/data/a.wav" }),
            ReceiptHandle: "rh-1",
          },
        ],
      })
      .mockResolvedValueOnce({});
    const consumer = makeConsumer(send, analyzeAudio);

    await consumer.pollOnce();

    expect(analyzeAudio).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2); // receive + delete
  });
```

- [ ] **Step 6: 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker`
Expected: FAIL (생성자 시그니처/분기 없음)

- [ ] **Step 7: consumer 구현**

`analysis.consumer.ts` 수정 — 생성자와 `handleMessage`를 교체 (다른 부분 유지):

```ts
import type { RecordingAnalysisResult } from "@bandapp/types";
import { GeminiService } from "../analysis/gemini.service.js";

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly gemini: GeminiService,
  ) {}

  private async handleMessage(message: Message): Promise<void> {
    const job = JSON.parse(message.Body ?? "") as {
      recordingId: string;
      audioPath?: string;
    };
    this.logger.log(`received analysis job: recordingId=${job.recordingId}`);

    if (!job.audioPath) {
      return;
    }
    if (!process.env.GEMINI_API_KEY) {
      this.logger.warn(
        `skipping gemini analysis for recordingId=${job.recordingId}: GEMINI_API_KEY is not set`,
      );
      return;
    }

    const takes = await this.gemini.analyzeAudio(job.audioPath);
    const result: RecordingAnalysisResult = {
      recordingId: job.recordingId,
      model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
      takes,
    };
    this.logger.log(`analysis result: ${JSON.stringify(result)}`);
  }
```

호출부는 `this.handleMessage(message)` → `await this.handleMessage(message)`로 변경. `worker.module.ts`의 providers를 `[AnalysisConsumer, GeminiService]`로 교체 (import 추가).

- [ ] **Step 8: 전체 테스트 + 커밋**

```bash
pnpm --filter @bandapp/api test
git add apps/api/src/analysis apps/api/src/worker
git commit -m "feat(api): analyze audio with gemini in worker consumer"
```

---

### Task 4: 라이브 검증 + README 예시

**Files:**
- Modify: `README.md` (분석 요청 예시에 audioPath 추가, 1–2줄)

**Interfaces:**
- Consumes: Task 1–3 전부, `.env`의 실제 `GEMINI_API_KEY` (사용자가 입력)

- [ ] **Step 1: 키 확인**

`.env`에서 `GEMINI_API_KEY=` 값이 비어 있지 않은지 확인 (값 자체를 로그/보고서에 절대 남기지 않는다). 비어 있으면 여기서 멈추고 BLOCKED로 보고 — 사용자가 넣어야 한다.

- [ ] **Step 2: 스택 재빌드 기동**

```bash
docker compose up --build -d -V
```

(-V: 의존성이 바뀌었으므로 익명 node_modules 볼륨 재생성. @google/genai가 컨테이너에 설치되게 함)

`curl -sf http://localhost:3001/health`가 응답할 때까지 대기.

- [ ] **Step 3: 테스트 오디오 선택 + 라이브 분석 요청**

`poc/data`에서 30초 내외 wav 하나를 고른다 (예: `Get-ChildItem poc/data -Recurse -Filter *.wav | Select-Object -First 3`으로 경로 확인 — band_full 풀의 클립 선호).

```bash
curl -si -X POST http://localhost:3001/recordings/live-1/analysis -H "Content-Type: application/json" -d "{\"audioPath\":\"poc/data/<선택한 경로>\"}"
```

Expected: 202.

- [ ] **Step 4: 결과 확인**

```bash
docker compose logs worker | grep -E "analysis result|analyzing|failed"
```

Expected: `analyzing poc/data/... with gemini-...` 로그 후 `analysis result: {"recordingId":"live-1","model":"...","takes":[...]}` JSON. takes 배열의 구간이 그럴듯한지 확인 (30초 클립이면 0~30000ms 범위).

실패 시: 로그의 오류를 근거로 원인 분석 (모델명 미존재 → `.env`의 GEMINI_MODEL을 실존 모델로 조정, 429/키 오류 → 사용자에게 보고). 원인 수정은 root cause에만 — 검증을 약화시키지 않는다.

- [ ] **Step 5: audioPath 없는 기존 경로 회귀 확인**

```bash
curl -s -X POST http://localhost:3001/recordings/no-audio/analysis
docker compose logs worker | grep "recordingId=no-audio"
```

Expected: 202 + 수신 로그만 (Gemini 미호출).

- [ ] **Step 6: README 예시 추가 + 커밋**

README의 분석 요청 항목을 다음처럼 보강:

```markdown
- 분석 요청: `curl -X POST http://localhost:3001/recordings/<id>/analysis` (Gemini 분석은 body에 `{"audioPath":"poc/data/....wav"}` 추가, `.env`에 `GEMINI_API_KEY` 필요)
```

```bash
git add README.md
git commit -m "docs: document gemini analysis dev request"
```

- [ ] **Step 7: 정리**

스택은 켜둔 채 보고 (사용자가 이어서 실험할 수 있게). `docker compose down`은 하지 않는다.
