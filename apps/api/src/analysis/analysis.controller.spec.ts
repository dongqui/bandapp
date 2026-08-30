import { BadRequestException } from "@nestjs/common";
import { AnalysisController } from "./analysis.controller.js";
import type { AnalysisProducer } from "./analysis.producer.js";

describe("AnalysisController", () => {
  it("enqueues the recording and returns QUEUED", async () => {
    const enqueueAnalysis = vi.fn().mockResolvedValue(undefined);
    const controller = new AnalysisController({
      enqueueAnalysis,
    } as unknown as AnalysisProducer);

    const result = await controller.requestAnalysis("rec_123", undefined);

    expect(enqueueAnalysis).toHaveBeenCalledWith("rec_123", undefined);
    expect(result).toEqual({ recordingId: "rec_123", status: "QUEUED" });
  });

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

  it("rejects a non-string audioPath with 400", async () => {
    const enqueueAnalysis = vi.fn().mockResolvedValue(undefined);
    const controller = new AnalysisController({
      enqueueAnalysis,
    } as unknown as AnalysisProducer);

    await expect(
      controller.requestAnalysis("rec_123", { audioPath: 123 as unknown as string }),
    ).rejects.toThrow(BadRequestException);
    expect(enqueueAnalysis).not.toHaveBeenCalled();
  });
});
