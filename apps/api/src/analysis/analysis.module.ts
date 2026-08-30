import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { AnalysisController } from "./analysis.controller.js";
import { AnalysisProducer } from "./analysis.producer.js";
import { geminiServiceProvider } from "./gemini.service.js";

@Module({
  imports: [QueueModule],
  controllers: [AnalysisController],
  providers: [AnalysisProducer, geminiServiceProvider],
})
export class AnalysisModule {}
