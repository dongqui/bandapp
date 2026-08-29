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
