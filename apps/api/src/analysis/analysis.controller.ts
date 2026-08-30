import { BadRequestException, Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { AnalysisProducer } from "./analysis.producer.js";

@Controller("recordings")
export class AnalysisController {
  constructor(private readonly producer: AnalysisProducer) {}

  @Post(":id/analysis")
  @HttpCode(202)
  async requestAnalysis(
    @Param("id") id: string,
    @Body() body?: { audioPath?: string },
  ): Promise<{ recordingId: string; status: "QUEUED" }> {
    if (body?.audioPath !== undefined && typeof body.audioPath !== "string") {
      throw new BadRequestException("audioPath must be a string");
    }
    await this.producer.enqueueAnalysis(id, body?.audioPath);
    return { recordingId: id, status: "QUEUED" };
  }
}
