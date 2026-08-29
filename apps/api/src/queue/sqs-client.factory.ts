import { SQSClient, type SQSClientConfig } from "@aws-sdk/client-sqs";

export function sqsClientOptions(env: NodeJS.ProcessEnv): SQSClientConfig {
  const endpoint = env.SQS_ENDPOINT;
  return {
    region: env.AWS_REGION ?? "ap-northeast-2",
    endpoint: endpoint || undefined,
    credentials: endpoint
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
        }
      : undefined,
  };
}

export function createSqsClient(env: NodeJS.ProcessEnv = process.env): SQSClient {
  return new SQSClient(sqsClientOptions(env));
}
