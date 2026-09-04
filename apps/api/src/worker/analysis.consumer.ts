import { Logger } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import type { AnalyzeSessionJob } from "@bandapp/types";
import { SQS_CLIENT } from "../queue/queue.constants.js";
import { SessionAnalysisService } from "./session-analysis.service.js";

/** 긴 분석 중 재전달을 막는다 (스펙 결정 8). 큐 기본 visibility(300초)와 같은 값으로 연장한다. */
const VISIBILITY_TIMEOUT_SEC = 300;
const DEFAULT_HEARTBEAT_MS = 60_000;
// 3시간(60초 간격 180회) 넘게 heartbeat가 갱신되면 멈춰버린 분석으로 보고 더 연장하지 않는다 —
// visibility가 만료되면 재전달되고, maxReceiveCount를 넘기면 DLQ로 빠진다.
const MAX_HEARTBEATS = 180;

export interface AnalysisConsumerOptions {
  heartbeatMs?: number;
  maxHeartbeats?: number;
}

export class AnalysisConsumer {
  private readonly logger = new Logger(AnalysisConsumer.name);
  private running = false;
  private readonly heartbeatMs: number;
  private readonly maxHeartbeats: number;

  constructor(
    private readonly sqs: SQSClient,
    private readonly analysis: SessionAnalysisService,
    { heartbeatMs = DEFAULT_HEARTBEAT_MS, maxHeartbeats = MAX_HEARTBEATS }: AnalysisConsumerOptions = {},
  ) {
    this.heartbeatMs = heartbeatMs;
    this.maxHeartbeats = maxHeartbeats;
  }

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
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          // 큐 자체의 visibility 속성에만 기대지 않는다 — SQS 기본값(30초)은 60초 heartbeat보다
          // 짧아서, 큐 설정이 어긋나면 heartbeat가 갱신되기도 전에 메시지가 재전달될 수 있다.
          VisibilityTimeout: VISIBILITY_TIMEOUT_SEC,
        }),
      );
      messages = result.Messages ?? [];
    } catch (error) {
      this.logger.error(`SQS receive failed, backing off: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, errorBackoffMs));
      return;
    }

    for (const message of messages) {
      const heartbeat = this.startHeartbeat(queueUrl, message.ReceiptHandle);
      try {
        await this.handleMessage(message);
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      } catch (error) {
        // 삭제하지 않으면 visibility timeout 이후 재전달된다.
        this.logger.error(`message handling failed, left for redelivery: ${String(error)}`);
      } finally {
        clearInterval(heartbeat);
      }
    }

    if (messages.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private startHeartbeat(queueUrl: string, receiptHandle: string | undefined): NodeJS.Timeout {
    let renewals = 0;
    let cappedLogged = false;
    return setInterval(() => {
      renewals += 1;
      if (renewals > this.maxHeartbeats) {
        if (!cappedLogged) {
          cappedLogged = true;
          this.logger.error(
            `heartbeat cap (${this.maxHeartbeats}) reached for a message still in flight, letting visibility expire so it can be redelivered/DLQ'd`,
          );
        }
        return;
      }
      this.sqs
        .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: VISIBILITY_TIMEOUT_SEC }))
        .catch((err: unknown) => this.logger.warn(`visibility extension failed: ${String(err)}`));
    }, this.heartbeatMs);
  }

  private async handleMessage(message: Message): Promise<void> {
    const job = JSON.parse(message.Body ?? "") as AnalyzeSessionJob;
    if (typeof job.sessionId !== "string") throw new Error("message has no sessionId");
    this.logger.log(`received analysis job: sessionId=${job.sessionId}`);
    await this.analysis.run(job.sessionId);
  }
}

export const analysisConsumerProvider: Provider = {
  provide: AnalysisConsumer,
  useFactory: (sqs: SQSClient, analysis: SessionAnalysisService) => new AnalysisConsumer(sqs, analysis),
  inject: [SQS_CLIENT, SessionAnalysisService],
};
