import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import type { RecordingAnalysisResult } from "@bandapp/types";
import { SQS_CLIENT } from "../queue/queue.constants.js";
import { GeminiService } from "../analysis/gemini.service.js";

@Injectable()
export class AnalysisConsumer {
  private readonly logger = new Logger(AnalysisConsumer.name);
  private running = false;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly gemini: GeminiService,
  ) {}

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
        await this.handleMessage(message);
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

    // Yield to event loop if no messages to allow graceful shutdown and prevent tight looping
    if (messages.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

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
}
