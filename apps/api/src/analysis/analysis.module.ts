import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { AnalysisProducer } from "./analysis.producer.js";
import { geminiServiceProvider } from "./gemini.service.js";

@Module({
  imports: [QueueModule],
  providers: [AnalysisProducer, geminiServiceProvider],
  exports: [AnalysisProducer, geminiServiceProvider],
})
export class AnalysisModule {}
