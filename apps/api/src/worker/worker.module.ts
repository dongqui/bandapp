import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { AnalysisConsumer } from "./analysis.consumer.js";
import { geminiServiceProvider } from "../analysis/gemini.service.js";

@Module({
  imports: [QueueModule],
  providers: [AnalysisConsumer, geminiServiceProvider],
})
export class WorkerModule {}
