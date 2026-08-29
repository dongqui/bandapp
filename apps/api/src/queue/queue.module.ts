import { Module } from "@nestjs/common";
import { SQS_CLIENT } from "./queue.constants.js";
import { createSqsClient } from "./sqs-client.factory.js";

@Module({
  providers: [{ provide: SQS_CLIENT, useFactory: () => createSqsClient() }],
  exports: [SQS_CLIENT],
})
export class QueueModule {}
