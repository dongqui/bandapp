import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module.js";
import { AnalysisController } from "./analysis.controller.js";
import { AnalysisProducer } from "./analysis.producer.js";

@Module({
  imports: [QueueModule],
  controllers: [AnalysisController],
  providers: [AnalysisProducer],
})
export class AnalysisModule {}
