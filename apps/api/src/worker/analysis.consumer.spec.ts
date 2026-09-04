import type { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { AnalysisConsumer } from "./analysis.consumer.js";
import type { SessionAnalysisService } from "./session-analysis.service.js";

describe("AnalysisConsumer", () => {
  const queueUrl = "http://localstack:4566/000000000000/recording-analysis";

  beforeEach(() => {
    process.env.SQS_ANALYSIS_QUEUE_URL = queueUrl;
  });

  afterEach(() => {
    delete process.env.SQS_ANALYSIS_QUEUE_URL;
    delete process.env.GEMINI_API_KEY;
  });

  function makeConsumer(
    send: ReturnType<typeof vi.fn>,
    run: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
    options: { heartbeatMs?: number; maxHeartbeats?: number } = { heartbeatMs: 10 },
  ) {
    const analysis = { run } as unknown as SessionAnalysisService;
    return { consumer: new AnalysisConsumer({ send } as unknown as SQSClient, analysis, options), run };
  }

  it("logs and deletes each received message", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          { Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-1" },
        ],
      })
      .mockResolvedValueOnce({});
    const { consumer } = makeConsumer(send);

    await consumer.pollOnce();

    expect(send).toHaveBeenCalledTimes(2);
    const receive = send.mock.calls[0][0] as ReceiveMessageCommand;
    expect(receive.input.QueueUrl).toBe(queueUrl);
    // 큐 자체의 VisibilityTimeout 속성이 어긋나 있어도(SQS 기본 30초 < 60초 heartbeat) 안전하도록
    // receive 요청에서 직접 지정한다.
    expect(receive.input.VisibilityTimeout).toBe(300);
    const del = send.mock.calls[1][0] as DeleteMessageCommand;
    expect(del.input.ReceiptHandle).toBe("rh-1");
  });

  it("does not delete a message whose handling fails", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Messages: [{ Body: "not-json", ReceiptHandle: "rh-1" }],
    });
    const { consumer } = makeConsumer(send);

    await consumer.pollOnce();

    expect(send).toHaveBeenCalledTimes(1); // receive만, delete 없음
  });

  it("backs off instead of crashing when receive fails", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const { consumer } = makeConsumer(send);

    await expect(consumer.pollOnce(0)).resolves.toBeUndefined();
  });

  it("stops the loop when stop() is called", async () => {
    const send = vi.fn().mockResolvedValue({ Messages: [] });
    const { consumer } = makeConsumer(send);

    setTimeout(() => consumer.stop(), 0);
    await consumer.start();

    expect(send).toHaveBeenCalled();
  });

  it("runs the analysis for the session and deletes the message", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Messages: [{ Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-1" }] })
      .mockResolvedValue({});
    const { consumer, run } = makeConsumer(send);
    await consumer.pollOnce();
    expect(run).toHaveBeenCalledWith("s-1");
    const del = send.mock.calls.at(-1)![0] as DeleteMessageCommand;
    expect(del.input.ReceiptHandle).toBe("rh-1");
  });

  it("extends message visibility while a long analysis runs", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Messages: [{ Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-1" }] })
      .mockResolvedValue({});
    const run = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 35)));
    const { consumer } = makeConsumer(send, run);
    await consumer.pollOnce();
    const visibility = send.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === "ChangeMessageVisibilityCommand") as ChangeMessageVisibilityCommand[];
    expect(visibility.length).toBeGreaterThanOrEqual(2);
    expect(visibility[0]!.input).toEqual({ QueueUrl: queueUrl, ReceiptHandle: "rh-1", VisibilityTimeout: 300 });
  });

  it("leaves the message when run() itself throws (e.g. DB down)", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Messages: [{ Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-1" }] });
    const { consumer } = makeConsumer(send, vi.fn().mockRejectedValue(new Error("db down")));
    await consumer.pollOnce();
    expect(send.mock.calls.some((c) => c[0].constructor.name === "DeleteMessageCommand")).toBe(false);
  });

  it("stops extending visibility once the heartbeat cap is reached", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Messages: [{ Body: JSON.stringify({ sessionId: "s-1" }), ReceiptHandle: "rh-1" }] })
      .mockResolvedValue({});
    const run = vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 30)));
    const { consumer } = makeConsumer(send, run, { heartbeatMs: 1, maxHeartbeats: 2 });
    await consumer.pollOnce();
    const visibility = send.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === "ChangeMessageVisibilityCommand");
    expect(visibility.length).toBeLessThanOrEqual(2);
  });
});
