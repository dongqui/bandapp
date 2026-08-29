# 로컬 개발 환경 (인프라 기반) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker compose up` 한 번으로 Postgres + LocalStack(SQS) + NestJS API/Worker + Python Worker가 기동되고, `POST /recordings/:id/analysis` → SQS → Worker 로그 경로가 동작하는 로컬 개발 환경을 만든다.

**Architecture:** 기존 `apps/api` NestJS 앱에 entry point를 2개(api.main / worker.main)로 분리하고, SQS 클라이언트를 QueueModule로 추상화한다. API는 producer로 메시지를 발행하고, Worker는 application context로 떠서 long-polling consumer를 돌린다. Python worker는 별도 실험 큐를 polling하는 골격만 만든다. 전부 Docker Compose로 오케스트레이션하고 LocalStack이 SQS를 대신한다.

**Tech Stack:** NestJS 12 (ESM), @aws-sdk/client-sqs v3, vitest, Python 3.12 + boto3 + uv, Docker Compose, LocalStack, PostgreSQL 17.

**Spec:** `docs/superpowers/specs/2026-08-29-local-dev-env-design.md`

## Global Constraints

- Node >= 22, pnpm 10.12.1 (packageManager 고정), `node-linker=hoisted` (.npmrc).
- `apps/api`는 ESM이다: `"type": "module"`, 상대 import에 반드시 `.js` 접미사 (`./queue.constants.js`).
- 테스트는 vitest globals (describe/it/expect/vi를 import 없이 사용), 파일명 `*.spec.ts`, 기존 스타일은 직접 인스턴스화(TestingModule 없이) — `apps/api/src/health/health.controller.spec.ts` 참조.
- AWS region 기본값: `ap-northeast-2`. 큐 이름 고정: `recording-analysis`, `recording-analysis-python`, `recording-analysis-dlq`.
- Python: requires-python `>=3.11`, 패키지 구조 `src/audio_worker/`, 테스트는 pytest.
- 범위 제외 (절대 추가하지 말 것): Gemini SDK, R2/Storage 구현, DB 스키마/마이그레이션, recording 상태 머신.
- Windows 저장소이므로 컨테이너에서 실행되는 셸 스크립트는 LF 필수 → `.gitattributes`로 강제 (Task 5).
- 커밋 메시지는 기존 관례를 따른다: `feat(api): ...`, `feat(audio-worker): ...`, `feat(infra): ...` 형식 + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: SQS 클라이언트 팩토리 + QueueModule

**Files:**
- Create: `apps/api/src/queue/queue.constants.ts`
- Create: `apps/api/src/queue/sqs-client.factory.ts`
- Create: `apps/api/src/queue/sqs-client.factory.spec.ts`
- Create: `apps/api/src/queue/queue.module.ts` (디렉터리째 신규)
- Modify: `apps/api/package.json`, `pnpm-lock.yaml` (의존성 추가로 자동 변경)

**Interfaces:**
- Consumes: 없음 (최초 태스크)
- Produces:
  - `SQS_CLIENT: unique symbol` — DI 토큰 (`queue.constants.ts`)
  - `sqsClientOptions(env: NodeJS.ProcessEnv): SQSClientConfig` — 순수 함수
  - `createSqsClient(env?: NodeJS.ProcessEnv): SQSClient`
  - `QueueModule` — `SQS_CLIENT`를 provide/export하는 NestJS 모듈

- [ ] **Step 1: 의존성 설치**

```bash
pnpm --filter @bandapp/api add @aws-sdk/client-sqs
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/api/src/queue/sqs-client.factory.spec.ts`:

```ts
import { sqsClientOptions } from "./sqs-client.factory.js";

describe("sqsClientOptions", () => {
  it("uses custom endpoint and dummy credentials when SQS_ENDPOINT is set", () => {
    const options = sqsClientOptions({
      SQS_ENDPOINT: "http://localstack:4566",
      AWS_REGION: "ap-northeast-2",
    } as NodeJS.ProcessEnv);

    expect(options.endpoint).toBe("http://localstack:4566");
    expect(options.region).toBe("ap-northeast-2");
    expect(options.credentials).toEqual({
      accessKeyId: "test",
      secretAccessKey: "test",
    });
  });

  it("uses AWS defaults when SQS_ENDPOINT is not set", () => {
    const options = sqsClientOptions({} as NodeJS.ProcessEnv);

    expect(options.endpoint).toBeUndefined();
    expect(options.credentials).toBeUndefined();
    expect(options.region).toBe("ap-northeast-2");
  });

  it("prefers explicit AWS credentials from env over dummy values", () => {
    const options = sqsClientOptions({
      SQS_ENDPOINT: "http://localstack:4566",
      AWS_ACCESS_KEY_ID: "abc",
      AWS_SECRET_ACCESS_KEY: "xyz",
    } as NodeJS.ProcessEnv);

    expect(options.credentials).toEqual({
      accessKeyId: "abc",
      secretAccessKey: "xyz",
    });
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/queue/sqs-client.factory.spec.ts`
Expected: FAIL — `sqs-client.factory.js` 모듈 없음.

- [ ] **Step 4: 구현**

`apps/api/src/queue/queue.constants.ts`:

```ts
export const SQS_CLIENT = Symbol("SQS_CLIENT");
```

`apps/api/src/queue/sqs-client.factory.ts`:

```ts
import { SQSClient, type SQSClientConfig } from "@aws-sdk/client-sqs";

export function sqsClientOptions(env: NodeJS.ProcessEnv): SQSClientConfig {
  const endpoint = env.SQS_ENDPOINT;
  return {
    region: env.AWS_REGION ?? "ap-northeast-2",
    endpoint: endpoint || undefined,
    credentials: endpoint
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
        }
      : undefined,
  };
}

export function createSqsClient(env: NodeJS.ProcessEnv = process.env): SQSClient {
  return new SQSClient(sqsClientOptions(env));
}
```

`apps/api/src/queue/queue.module.ts` (기존 빈 `@Module({})` 스텁을 교체):

```ts
import { Module } from "@nestjs/common";
import { SQS_CLIENT } from "./queue.constants.js";
import { createSqsClient } from "./sqs-client.factory.js";

@Module({
  providers: [{ provide: SQS_CLIENT, useFactory: () => createSqsClient() }],
  exports: [SQS_CLIENT],
})
export class QueueModule {}
```

주의: `app.module.ts`에는 QueueModule을 등록하지 않는다 — Analysis/Worker 모듈이 각자 import한다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/queue/sqs-client.factory.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: 전체 테스트 + 커밋**

```bash
pnpm --filter @bandapp/api test
git add apps/api/src/queue apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add queue module with sqs client factory"
```

---

### Task 2: Analysis producer + POST /recordings/:id/analysis

**Files:**
- Create: `apps/api/src/analysis/analysis.producer.ts`
- Create: `apps/api/src/analysis/analysis.producer.spec.ts`
- Create: `apps/api/src/analysis/analysis.controller.ts`
- Create: `apps/api/src/analysis/analysis.controller.spec.ts`
- Modify: `apps/api/src/analysis/analysis.module.ts` (빈 스텁 → 등록)

**Interfaces:**
- Consumes: `SQS_CLIENT` 토큰, `QueueModule` (Task 1)
- Produces:
  - `AnalysisProducer.enqueueAnalysis(recordingId: string): Promise<void>` — `SQS_ANALYSIS_QUEUE_URL` 큐에 `{"recordingId":"..."}` JSON body 발행
  - `POST /recordings/:id/analysis` → `202 { recordingId, status: "QUEUED" }`

- [ ] **Step 1: producer 실패 테스트 작성**

`apps/api/src/analysis/analysis.producer.spec.ts`:

```ts
import type { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { AnalysisProducer } from "./analysis.producer.js";

describe("AnalysisProducer", () => {
  const queueUrl = "http://localstack:4566/000000000000/recording-analysis";

  beforeEach(() => {
    process.env.SQS_ANALYSIS_QUEUE_URL = queueUrl;
  });

  afterEach(() => {
    delete process.env.SQS_ANALYSIS_QUEUE_URL;
  });

  it("sends a message with the recording id to the analysis queue", async () => {
    const send = vi.fn().mockResolvedValue({});
    const producer = new AnalysisProducer({ send } as unknown as SQSClient);

    await producer.enqueueAnalysis("rec_123");

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as SendMessageCommand;
    expect(command.input.QueueUrl).toBe(queueUrl);
    expect(JSON.parse(command.input.MessageBody!)).toEqual({ recordingId: "rec_123" });
  });

  it("throws when the queue url is not configured", async () => {
    delete process.env.SQS_ANALYSIS_QUEUE_URL;
    const producer = new AnalysisProducer({ send: vi.fn() } as unknown as SQSClient);

    await expect(producer.enqueueAnalysis("rec_123")).rejects.toThrow(
      "SQS_ANALYSIS_QUEUE_URL",
    );
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/analysis.producer.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: producer 구현**

`apps/api/src/analysis/analysis.producer.ts`:

```ts
import { Inject, Injectable } from "@nestjs/common";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { SQS_CLIENT } from "../queue/queue.constants.js";

@Injectable()
export class AnalysisProducer {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  async enqueueAnalysis(recordingId: string): Promise<void> {
    const queueUrl = process.env.SQS_ANALYSIS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("SQS_ANALYSIS_QUEUE_URL is not set");
    }
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ recordingId }),
      }),
    );
  }
}
```

- [ ] **Step 4: producer 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/analysis.producer.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: controller 실패 테스트 작성**

`apps/api/src/analysis/analysis.controller.spec.ts`:

```ts
import { AnalysisController } from "./analysis.controller.js";
import type { AnalysisProducer } from "./analysis.producer.js";

describe("AnalysisController", () => {
  it("enqueues the recording and returns QUEUED", async () => {
    const enqueueAnalysis = vi.fn().mockResolvedValue(undefined);
    const controller = new AnalysisController({
      enqueueAnalysis,
    } as unknown as AnalysisProducer);

    const result = await controller.requestAnalysis("rec_123");

    expect(enqueueAnalysis).toHaveBeenCalledWith("rec_123");
    expect(result).toEqual({ recordingId: "rec_123", status: "QUEUED" });
  });
});
```

- [ ] **Step 6: 테스트 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/analysis/analysis.controller.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 7: controller 구현 + 모듈 등록**

`apps/api/src/analysis/analysis.controller.ts`:

```ts
import { Controller, HttpCode, Param, Post } from "@nestjs/common";
import { AnalysisProducer } from "./analysis.producer.js";

@Controller("recordings")
export class AnalysisController {
  constructor(private readonly producer: AnalysisProducer) {}

  @Post(":id/analysis")
  @HttpCode(202)
  async requestAnalysis(
    @Param("id") id: string,
  ): Promise<{ recordingId: string; status: "QUEUED" }> {
    await this.producer.enqueueAnalysis(id);
    return { recordingId: id, status: "QUEUED" };
  }
}
```

`apps/api/src/analysis/analysis.module.ts` (기존 빈 `@Module({})` 교체):

```ts
import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { AnalysisController } from "./analysis.controller.js";
import { AnalysisProducer } from "./analysis.producer.js";

@Module({
  imports: [QueueModule],
  controllers: [AnalysisController],
  providers: [AnalysisProducer],
})
export class AnalysisModule {}
```

`AnalysisModule`은 이미 `app.module.ts`에 등록되어 있으므로 app.module.ts는 수정하지 않는다.

- [ ] **Step 8: 전체 테스트 통과 확인 (e2e 포함)**

Run: `pnpm --filter @bandapp/api test`
Expected: PASS — 기존 `/health` e2e가 AnalysisModule 포함 부팅을 함께 검증한다 (SQSClient 생성은 네트워크 연결을 하지 않으므로 env 없이도 부팅됨).

- [ ] **Step 9: 커밋**

```bash
git add apps/api/src/analysis
git commit -m "feat(api): add analysis producer and enqueue endpoint"
```

---

### Task 3: Worker consumer + entry point 분리

**Files:**
- Create: `apps/api/src/worker/analysis.consumer.ts`
- Create: `apps/api/src/worker/analysis.consumer.spec.ts`
- Create: `apps/api/src/worker/worker.module.ts`
- Create: `apps/api/src/worker.main.ts`
- Rename: `apps/api/src/main.ts` → `apps/api/src/api.main.ts` (`git mv`)
- Modify: `apps/api/package.json` (scripts)

**Interfaces:**
- Consumes: `SQS_CLIENT`, `QueueModule` (Task 1)
- Produces:
  - `AnalysisConsumer.pollOnce(errorBackoffMs?: number): Promise<void>` — 1회 수신·처리
  - `AnalysisConsumer.start(): Promise<void>` / `stop(): void` — polling 루프 제어
  - `WorkerModule` — QueueModule import, AnalysisConsumer provide
  - npm scripts: `start:api:dev`, `start:worker:dev` (Task 5의 compose가 사용)

- [ ] **Step 1: consumer 실패 테스트 작성**

`apps/api/src/worker/analysis.consumer.spec.ts`:

```ts
import type {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { AnalysisConsumer } from "./analysis.consumer.js";

describe("AnalysisConsumer", () => {
  const queueUrl = "http://localstack:4566/000000000000/recording-analysis";

  beforeEach(() => {
    process.env.SQS_ANALYSIS_QUEUE_URL = queueUrl;
  });

  afterEach(() => {
    delete process.env.SQS_ANALYSIS_QUEUE_URL;
  });

  function makeConsumer(send: ReturnType<typeof vi.fn>) {
    return new AnalysisConsumer({ send } as unknown as SQSClient);
  }

  it("logs and deletes each received message", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          { Body: JSON.stringify({ recordingId: "rec_1" }), ReceiptHandle: "rh-1" },
        ],
      })
      .mockResolvedValueOnce({});
    const consumer = makeConsumer(send);

    await consumer.pollOnce();

    expect(send).toHaveBeenCalledTimes(2);
    const receive = send.mock.calls[0][0] as ReceiveMessageCommand;
    expect(receive.input.QueueUrl).toBe(queueUrl);
    const del = send.mock.calls[1][0] as DeleteMessageCommand;
    expect(del.input.ReceiptHandle).toBe("rh-1");
  });

  it("does not delete a message whose handling fails", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Messages: [{ Body: "not-json", ReceiptHandle: "rh-1" }],
    });
    const consumer = makeConsumer(send);

    await consumer.pollOnce();

    expect(send).toHaveBeenCalledTimes(1); // receive만, delete 없음
  });

  it("backs off instead of crashing when receive fails", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const consumer = makeConsumer(send);

    await expect(consumer.pollOnce(0)).resolves.toBeUndefined();
  });

  it("stops the loop when stop() is called", async () => {
    const send = vi.fn().mockResolvedValue({ Messages: [] });
    const consumer = makeConsumer(send);

    setTimeout(() => consumer.stop(), 0);
    await consumer.start();

    expect(send).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/analysis.consumer.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: consumer + WorkerModule 구현**

`apps/api/src/worker/analysis.consumer.ts`:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { SQS_CLIENT } from "../queue/queue.constants.js";

@Injectable()
export class AnalysisConsumer {
  private readonly logger = new Logger(AnalysisConsumer.name);
  private running = false;

  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  async start(): Promise<void> {
    this.running = true;
    this.logger.log("analysis consumer started");
    while (this.running) {
      await this.pollOnce();
    }
    this.logger.log("analysis consumer stopped");
  }

  stop(): void {
    this.running = false;
  }

  async pollOnce(errorBackoffMs = 5000): Promise<void> {
    const queueUrl = process.env.SQS_ANALYSIS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("SQS_ANALYSIS_QUEUE_URL is not set");
    }

    let messages: Message[];
    try {
      const result = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
        }),
      );
      messages = result.Messages ?? [];
    } catch (error) {
      this.logger.error(`SQS receive failed, backing off: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, errorBackoffMs));
      return;
    }

    for (const message of messages) {
      try {
        this.handleMessage(message);
        await this.sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      } catch (error) {
        // 삭제하지 않으면 visibility timeout 이후 재전달된다.
        this.logger.error(`message handling failed, left for redelivery: ${String(error)}`);
      }
    }
  }

  private handleMessage(message: Message): void {
    const job = JSON.parse(message.Body ?? "") as { recordingId: string };
    this.logger.log(`received analysis job: recordingId=${job.recordingId}`);
  }
}
```

`apps/api/src/worker/worker.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { AnalysisConsumer } from "./analysis.consumer.js";

@Module({
  imports: [QueueModule],
  providers: [AnalysisConsumer],
})
export class WorkerModule {}
```

- [ ] **Step 4: consumer 테스트 통과 확인**

Run: `pnpm --filter @bandapp/api exec vitest run src/worker/analysis.consumer.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: entry point 분리**

```bash
git mv apps/api/src/main.ts apps/api/src/api.main.ts
```

`apps/api/src/worker.main.ts` 신설:

```ts
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker/worker.module.js";
import { AnalysisConsumer } from "./worker/analysis.consumer.js";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const consumer = app.get(AnalysisConsumer);

  const shutdown = async () => {
    consumer.stop();
    await app.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await consumer.start();
}
await bootstrap();
```

`apps/api/package.json` scripts 수정 (해당 키만 교체/추가, 나머지는 그대로):

```json
{
  "start": "nest start --entryFile api.main",
  "start:dev": "nest start --watch --entryFile api.main",
  "start:api:dev": "nest start --watch --entryFile api.main",
  "start:worker:dev": "nest start --watch --entryFile worker.main",
  "start:debug": "nest start --debug --watch --entryFile api.main",
  "start:prod": "node dist/api.main"
}
```

- [ ] **Step 6: 빌드 + 두 entry 기동 확인**

```bash
pnpm --filter @bandapp/api build
```

Expected: 성공, `apps/api/dist/api.main.js`와 `apps/api/dist/worker.main.js` 존재.

API smoke: `pnpm --filter @bandapp/api exec node dist/api.main.js` 실행 → 다른 터미널에서 `curl http://localhost:3000/health`가 `{"status":"ok"}` 반환 → Ctrl+C 종료.
Worker smoke: `SQS_ANALYSIS_QUEUE_URL` 미설정으로 `node dist/worker.main.js` 실행 시 "SQS_ANALYSIS_QUEUE_URL is not set" 오류로 종료하는 것이 정상 (큐 URL은 compose가 주입).

- [ ] **Step 7: 전체 테스트 + 커밋**

```bash
pnpm --filter @bandapp/api test
git add apps/api/src apps/api/package.json
git commit -m "feat(api): split api/worker entry points and add sqs consumer"
```

---

### Task 4: Python worker — 실험 큐 polling 골격

**Files:**
- Create: `apps/audio-worker/src/audio_worker/queue_consumer.py`
- Create: `apps/audio-worker/tests/test_queue_consumer.py`
- Modify: `apps/audio-worker/src/audio_worker/__main__.py`
- Modify: `apps/audio-worker/tests/test_smoke.py`
- Modify: `apps/audio-worker/pyproject.toml` (boto3 추가)

**Interfaces:**
- Consumes: 없음 (Node 쪽과 독립)
- Produces:
  - `poll_once(sqs, queue_url: str) -> int` — 1회 수신·로그·삭제, 처리 건수 반환
  - `main() -> int` — `SQS_PYTHON_ANALYSIS_QUEUE_URL` 미설정 시 scaffold 메시지 출력 후 0 반환(기존 동작 유지), 설정 시 무한 polling 루프

- [ ] **Step 1: pyproject에 boto3 추가**

`apps/audio-worker/pyproject.toml`의 `dependencies` 교체:

```toml
dependencies = ["boto3>=1.35"]
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/audio-worker/tests/test_queue_consumer.py`:

```python
from audio_worker.queue_consumer import poll_once


class FakeSqs:
    def __init__(self, messages):
        self._messages = messages
        self.deleted = []

    def receive_message(self, **kwargs):
        assert kwargs["QueueUrl"] == "http://localstack:4566/q"
        return {"Messages": self._messages} if self._messages else {}

    def delete_message(self, **kwargs):
        self.deleted.append(kwargs["ReceiptHandle"])


def test_poll_once_logs_and_deletes_messages(capsys):
    sqs = FakeSqs([{"Body": '{"recordingId": "rec_1"}', "ReceiptHandle": "rh-1"}])

    count = poll_once(sqs, "http://localstack:4566/q")

    assert count == 1
    assert sqs.deleted == ["rh-1"]
    assert "rec_1" in capsys.readouterr().out


def test_poll_once_returns_zero_when_queue_is_empty():
    sqs = FakeSqs([])

    assert poll_once(sqs, "http://localstack:4566/q") == 0
    assert sqs.deleted == []
```

- [ ] **Step 3: 테스트 실패 확인**

Run (`apps/audio-worker`에서): `uv run --extra dev pytest tests/test_queue_consumer.py -v`
Expected: FAIL — `queue_consumer` 모듈 없음.
(uv가 호스트에 없으면 `python -m venv .venv` + `.venv\Scripts\pip install -e .[dev]` + `.venv\Scripts\python -m pytest`로 동일하게 실행.)

- [ ] **Step 4: 구현**

`apps/audio-worker/src/audio_worker/queue_consumer.py`:

```python
"""LocalStack/AWS SQS 실험 큐를 polling하는 최소 consumer."""

from typing import Any, Protocol


class SqsClient(Protocol):
    def receive_message(self, **kwargs: Any) -> dict: ...
    def delete_message(self, **kwargs: Any) -> None: ...


def poll_once(sqs: SqsClient, queue_url: str) -> int:
    response = sqs.receive_message(
        QueueUrl=queue_url,
        MaxNumberOfMessages=10,
        WaitTimeSeconds=20,
    )
    messages = response.get("Messages", [])
    for message in messages:
        print(f"[audio-worker] received: {message['Body']}", flush=True)
        sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=message["ReceiptHandle"])
    return len(messages)
```

`apps/audio-worker/src/audio_worker/__main__.py` 전체 교체:

```python
import os
import time

from audio_worker import __version__
from audio_worker.queue_consumer import poll_once


def main() -> int:
    queue_url = os.environ.get("SQS_PYTHON_ANALYSIS_QUEUE_URL")
    if not queue_url:
        print(f"bandapp audio-worker {__version__} (scaffold; no queue configured)")
        return 0

    import boto3

    sqs = boto3.client(
        "sqs",
        region_name=os.environ.get("AWS_REGION", "ap-northeast-2"),
        endpoint_url=os.environ.get("SQS_ENDPOINT") or None,
    )
    print(f"bandapp audio-worker {__version__} polling {queue_url}", flush=True)
    while True:
        try:
            poll_once(sqs, queue_url)
        except Exception as exc:  # noqa: BLE001 — 어떤 오류든 worker는 살아있어야 한다
            print(f"[audio-worker] poll failed, retrying in 5s: {exc}", flush=True)
            time.sleep(5)


if __name__ == "__main__":
    raise SystemExit(main())
```

`apps/audio-worker/tests/test_smoke.py`의 `test_main_returns_zero`가 env에 따라 흔들리지 않도록 교체:

```python
from audio_worker import __version__
from audio_worker.__main__ import main


def test_version_is_set():
    assert __version__ == "0.0.1"


def test_main_returns_zero_without_queue_env(monkeypatch, capsys):
    monkeypatch.delenv("SQS_PYTHON_ANALYSIS_QUEUE_URL", raising=False)
    assert main() == 0
    assert "audio-worker" in capsys.readouterr().out
```

- [ ] **Step 5: 테스트 통과 확인**

Run (`apps/audio-worker`에서): `uv run --extra dev pytest -v`
Expected: PASS (4 tests — smoke 2 + queue_consumer 2)

- [ ] **Step 6: 커밋**

```bash
git add apps/audio-worker
git commit -m "feat(audio-worker): add experimental sqs polling skeleton"
```

---

### Task 5: Docker Compose + Dockerfile + LocalStack init + .env.example

**Files:**
- Create: `docker-compose.yml` (루트)
- Create: `apps/api/Dockerfile`
- Create: `apps/audio-worker/Dockerfile`
- Create: `docker/localstack/init-aws.sh`
- Create: `.gitattributes` (루트)
- Create: `.env.example` (루트)
- Modify: `.gitignore` (`.env` 추가)
- Modify: `package.json` (루트 — docker 스크립트)

**Interfaces:**
- Consumes: `start:api:dev` / `start:worker:dev` 스크립트 (Task 3), `python -m audio_worker` (Task 4)
- Produces: `docker compose up`으로 기동되는 5개 서비스 (`postgres`, `localstack`, `api`, `worker`, `audio-worker`)

- [ ] **Step 1: .gitattributes 먼저 생성 (CRLF 방지 — .sh 커밋 전에 필수)**

`.gitattributes`:

```text
*.sh text eol=lf
```

- [ ] **Step 2: LocalStack init 스크립트**

`docker/localstack/init-aws.sh`:

```bash
#!/bin/sh
set -e

awslocal sqs create-queue --queue-name recording-analysis
awslocal sqs create-queue --queue-name recording-analysis-python
awslocal sqs create-queue --queue-name recording-analysis-dlq

echo "Local SQS queues created."
```

- [ ] **Step 3: NestJS Dockerfile**

`apps/api/Dockerfile` (context는 저장소 루트, `node-linker=hoisted` 전제):

```dockerfile
FROM node:22-alpine

RUN corepack enable
WORKDIR /app

# 워크스페이스 manifest만 먼저 복사해 install 레이어를 캐시한다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
COPY packages/api-client/package.json packages/api-client/

# mobile(Expo) 의존성은 제외하고 api와 그 워크스페이스 의존성만 설치.
RUN pnpm install --frozen-lockfile --filter @bandapp/api...

COPY . .

EXPOSE 3000
CMD ["pnpm", "--filter", "@bandapp/api", "start:api:dev"]
```

- [ ] **Step 4: Python Dockerfile**

`apps/audio-worker/Dockerfile` (context는 저장소 루트):

```dockerfile
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

# venv를 /opt에 두어 소스 볼륨 마운트에 가려지지 않게 한다.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv

COPY apps/audio-worker/pyproject.toml ./
COPY apps/audio-worker/src ./src
RUN uv sync --no-dev

ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
CMD ["python", "-m", "audio_worker"]
```

- [ ] **Step 5: docker-compose.yml**

루트 `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: band
      POSTGRES_USER: band
      POSTGRES_PASSWORD: band
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U band -d band"]
      interval: 5s
      timeout: 5s
      retries: 10

  localstack:
    image: localstack/localstack:latest
    restart: unless-stopped
    ports:
      - "4566:4566"
    environment:
      SERVICES: sqs
      AWS_DEFAULT_REGION: ap-northeast-2
      DEBUG: 0
    volumes:
      - ./docker/localstack/init-aws.sh:/etc/localstack/init/ready.d/init-aws.sh
      - localstack-data:/var/lib/localstack

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    restart: unless-stopped
    # @bandapp/types는 dist를 배포하는 패키지라 dev 기동 전에 빌드가 필요하다.
    command: sh -c "pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api start:api:dev"
    env_file: [.env]
    environment:
      DATABASE_URL: postgresql://band:band@postgres:5432/band
      SQS_ENDPOINT: http://localstack:4566
      TSC_WATCHFILE: DynamicPriorityPolling
    ports:
      - "3000:3000"
    volumes:
      - .:/app
      - /app/node_modules
      - /app/apps/api/node_modules
      - /app/apps/mobile/node_modules
      - /app/packages/types/node_modules
      - /app/packages/config/node_modules
      - /app/packages/api-client/node_modules
    depends_on:
      postgres:
        condition: service_healthy
      localstack:
        condition: service_started

  worker:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    restart: unless-stopped
    command: sh -c "pnpm --filter @bandapp/types build && pnpm --filter @bandapp/api start:worker:dev"
    env_file: [.env]
    environment:
      DATABASE_URL: postgresql://band:band@postgres:5432/band
      SQS_ENDPOINT: http://localstack:4566
      TSC_WATCHFILE: DynamicPriorityPolling
    volumes:
      - .:/app
      - /app/node_modules
      - /app/apps/api/node_modules
      - /app/apps/mobile/node_modules
      - /app/packages/types/node_modules
      - /app/packages/config/node_modules
      - /app/packages/api-client/node_modules
    depends_on:
      postgres:
        condition: service_healthy
      localstack:
        condition: service_started

  audio-worker:
    build:
      context: .
      dockerfile: apps/audio-worker/Dockerfile
    restart: unless-stopped
    env_file: [.env]
    environment:
      SQS_ENDPOINT: http://localstack:4566
    volumes:
      - ./apps/audio-worker/src:/app/src
    depends_on:
      localstack:
        condition: service_started

volumes:
  postgres-data:
  localstack-data:
```

참고:
- `TSC_WATCHFILE=DynamicPriorityPolling` — Windows bind mount에서 tsc watch가 파일 변경을 못 잡는 문제를 polling으로 우회.
- 익명 볼륨들은 호스트(Windows)의 `node_modules`가 컨테이너(Linux) 것을 덮어쓰지 않게 한다. 익명 볼륨은 최초 생성 시 이미지 내용으로 초기화된다.
- `container_name` 미지정 — `--scale worker=N` 대비.

- [ ] **Step 6: .env.example / .gitignore / 루트 스크립트**

`.env.example`:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://band:band@postgres:5432/band

AWS_REGION=ap-northeast-2
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test

# 컨테이너 내부 기준 주소. SQS 요청은 SQS_ENDPOINT로 전송되므로
# 큐 URL의 호스트명이 해석될 필요는 없다.
SQS_ENDPOINT=http://localstack:4566
SQS_ANALYSIS_QUEUE_URL=http://localstack:4566/000000000000/recording-analysis
SQS_PYTHON_ANALYSIS_QUEUE_URL=http://localstack:4566/000000000000/recording-analysis-python

# 아래는 다음 단계(Gemini/R2)용 placeholder — 이번 범위에서는 비워 둔다.
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash

STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=band-rehearsal-dev
R2_ENDPOINT=
```

`.gitignore`에 한 줄 추가:

```text
.env
```

루트 `package.json` scripts에 추가 (기존 스크립트 유지):

```json
{
  "docker:up": "docker compose up -d",
  "docker:down": "docker compose down",
  "docker:logs": "docker compose logs -f",
  "docker:build": "docker compose build"
}
```

- [ ] **Step 7: compose 문법 검증**

```bash
cp .env.example .env
docker compose config -q
```

Expected: 출력 없이 exit 0 (`.env`는 커밋하지 않음).

- [ ] **Step 8: 커밋**

```bash
git add docker-compose.yml apps/api/Dockerfile apps/audio-worker/Dockerfile docker/localstack/init-aws.sh .gitattributes .env.example .gitignore package.json
git commit -m "feat(infra): add docker compose stack with localstack sqs"
```

주의: `git add` 후 `git ls-files --eol docker/localstack/init-aws.sh`로 index가 `lf`인지 확인. `crlf`라면 `.gitattributes` 적용 후 `git add --renormalize .`를 실행한다.

---

### Task 6: 전체 스택 검증 + README

**Files:**
- Modify: `README.md` (루트 — 로컬 실행 quickstart 섹션 추가)

**Interfaces:**
- Consumes: Task 1~5 전부
- Produces: 스펙의 "수동 검증 (완료 조건)" 충족 확인

- [ ] **Step 1: 스택 기동**

```bash
docker compose up --build -d
docker compose ps
```

Expected: 5개 서비스 모두 Up (api/worker는 types 빌드 후 watch 기동까지 수십 초 소요).

```bash
docker compose logs localstack | grep "Local SQS queues created"
```

Expected: init 스크립트 실행 로그 확인.

- [ ] **Step 2: API → SQS → Worker 경로 검증**

```bash
curl -i -X POST http://localhost:3000/recordings/test-1/analysis
```

Expected: `HTTP/1.1 202 Accepted`, body `{"recordingId":"test-1","status":"QUEUED"}`.

```bash
docker compose logs worker | grep "recordingId=test-1"
```

Expected: `received analysis job: recordingId=test-1` 로그.

- [ ] **Step 3: Python worker 경로 검증**

```bash
docker compose exec localstack awslocal sqs send-message --queue-url http://localhost:4566/000000000000/recording-analysis-python --message-body "{\"recordingId\":\"py-test-1\",\"mode\":\"yamnet\"}"
docker compose logs audio-worker | grep "py-test-1"
```

Expected: `[audio-worker] received: {"recordingId":"py-test-1",...}` 로그.

- [ ] **Step 4: 재기동 내성 확인**

```bash
docker compose down
docker compose up -d
curl -i -X POST http://localhost:3000/recordings/test-2/analysis
docker compose logs worker | grep "recordingId=test-2"
```

Expected: 동일 동작.

- [ ] **Step 5: 전체 테스트 재실행**

```bash
pnpm test
```

(`apps/audio-worker`에서) `uv run --extra dev pytest`

Expected: 모두 PASS.

- [ ] **Step 6: README quickstart 추가**

루트 `README.md`에 아래 섹션 추가 (기존 내용 유지, 적절한 위치에):

```markdown
## 로컬 개발 환경

```bash
cp .env.example .env   # 최초 1회
docker compose up --build -d
```

- API: http://localhost:3000 (health: `GET /health`)
- 분석 요청: `curl -X POST http://localhost:3000/recordings/<id>/analysis` → worker 컨테이너 로그로 수신 확인
- 큐: LocalStack SQS (`recording-analysis`, `recording-analysis-python`, `recording-analysis-dlq`)
- 종료: `docker compose down`
```

- [ ] **Step 7: 커밋**

```bash
git add README.md
git commit -m "docs: add local dev environment quickstart"
```

- [ ] **Step 8: 스택 정리**

```bash
docker compose down
```
