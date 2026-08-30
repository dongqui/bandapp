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
});
