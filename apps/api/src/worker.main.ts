import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker/worker.module.js";
import { AnalysisConsumer } from "./worker/analysis.consumer.js";

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const consumer = app.get(AnalysisConsumer);

  const shutdown = async () => {
    consumer.stop();
    await app.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await consumer.start();
}
await bootstrap();
