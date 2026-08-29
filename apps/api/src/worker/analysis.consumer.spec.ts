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
