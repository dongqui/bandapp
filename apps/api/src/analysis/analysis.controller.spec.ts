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
