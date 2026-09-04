import { Module } from "@nestjs/common";
import { geminiServiceProvider } from "../analysis/gemini.service.js";
import { DbModule } from "../db/db.module.js";
import { QueueModule } from "../queue/queue.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { analysisConsumerProvider } from "./analysis.consumer.js";
import { sessionAnalysisServiceProvider } from "./session-analysis.service.js";

@Module({
  imports: [QueueModule, DbModule, StorageModule],
  providers: [geminiServiceProvider, sessionAnalysisServiceProvider, analysisConsumerProvider],
})
export class WorkerModule {}
