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

  it("sends a message with the session id to the analysis queue", async () => {
    const send = vi.fn().mockResolvedValue({});
    const producer = new AnalysisProducer({ send } as unknown as SQSClient);

    await producer.enqueueAnalysis("s-1");

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as SendMessageCommand;
    expect(command.input.QueueUrl).toBe(queueUrl);
    expect(JSON.parse(command.input.MessageBody!)).toEqual({ sessionId: "s-1" });
  });

  it("throws when the queue url is not configured", async () => {
    delete process.env.SQS_ANALYSIS_QUEUE_URL;
    const producer = new AnalysisProducer({ send: vi.fn() } as unknown as SQSClient);

    await expect(producer.enqueueAnalysis("s-1")).rejects.toThrow(
      "SQS_ANALYSIS_QUEUE_URL",
    );
  });
});
