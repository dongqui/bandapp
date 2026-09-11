import { Inject, Injectable } from "@nestjs/common";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AnalyzeSessionJob, RecutTakeJob } from "@bandapp/types";
import { SQS_CLIENT } from "../queue/queue.constants.js";

@Injectable()
export class AnalysisProducer {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  async enqueueAnalysis(sessionId: string): Promise<void> {
    const job: AnalyzeSessionJob = { sessionId };
    await this.send(job);
  }

  /** take 재컷 잡 — 분석과 같은 큐를 쓴다 (2026-09-11 스펙 B 결정 3). 컨슈머가 type으로 분기한다 */
  async enqueueRecut(takeId: string, version: number): Promise<void> {
    const job: RecutTakeJob = { type: "recut", takeId, version };
    await this.send(job);
  }

  private async send(job: AnalyzeSessionJob | RecutTakeJob): Promise<void> {
    const queueUrl = process.env.SQS_ANALYSIS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("SQS_ANALYSIS_QUEUE_URL is not set");
    }
    await this.sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job) }));
  }
}
