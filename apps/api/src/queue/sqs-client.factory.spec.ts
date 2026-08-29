import { sqsClientOptions } from "./sqs-client.factory.js";

describe("sqsClientOptions", () => {
  it("uses custom endpoint and dummy credentials when SQS_ENDPOINT is set", () => {
    const options = sqsClientOptions({
      SQS_ENDPOINT: "http://localstack:4566",
      AWS_REGION: "ap-northeast-2",
    } as NodeJS.ProcessEnv);

    expect(options.endpoint).toBe("http://localstack:4566");
    expect(options.region).toBe("ap-northeast-2");
    expect(options.credentials).toEqual({
      accessKeyId: "test",
      secretAccessKey: "test",
    });
  });

  it("uses AWS defaults when SQS_ENDPOINT is not set", () => {
    const options = sqsClientOptions({} as NodeJS.ProcessEnv);

    expect(options.endpoint).toBeUndefined();
    expect(options.credentials).toBeUndefined();
    expect(options.region).toBe("ap-northeast-2");
  });

  it("prefers explicit AWS credentials from env over dummy values", () => {
    const options = sqsClientOptions({
      SQS_ENDPOINT: "http://localstack:4566",
      AWS_ACCESS_KEY_ID: "abc",
      AWS_SECRET_ACCESS_KEY: "xyz",
    } as NodeJS.ProcessEnv);

    expect(options.credentials).toEqual({
      accessKeyId: "abc",
      secretAccessKey: "xyz",
    });
  });
});
