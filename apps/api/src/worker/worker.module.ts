import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { AnalysisConsumer } from "./analysis.consumer.js";

@Module({
  imports: [QueueModule],
  providers: [AnalysisConsumer],
})
export class WorkerModule {}
