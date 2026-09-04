import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { R2StorageService, r2ClientConfig } from "./storage.service.js";

function makeService(send: ReturnType<typeof vi.fn>, presign = vi.fn().mockResolvedValue("https://signed")) {
  process.env.R2_BUCKET = "taken-rehearsal-dev";
  const client = { send } as unknown as S3Client;
  return { service: new R2StorageService(() => client, presign), presign };
}

afterEach(() => {
  delete process.env.R2_BUCKET;
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_ENDPOINT;
});

describe("r2ClientConfig", () => {
  it("derives the endpoint from the account id and disables checksum injection", () => {
    const config = r2ClientConfig({
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
    } as NodeJS.ProcessEnv);
    expect(config.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(config.region).toBe("auto");
    expect(config.requestChecksumCalculation).toBe("WHEN_REQUIRED");
    expect(config.responseChecksumValidation).toBe("WHEN_REQUIRED");
  });
  it("prefers R2_ENDPOINT when set", () => {
    const config = r2ClientConfig({
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
      R2_ENDPOINT: "http://localhost:9000",
    } as NodeJS.ProcessEnv);
    expect(config.endpoint).toBe("http://localhost:9000");
  });
  it("throws when credentials are missing", () => {
    expect(() => r2ClientConfig({} as NodeJS.ProcessEnv)).toThrow("R2_ACCOUNT_ID");
  });
});

describe("R2StorageService", () => {
  it("createMultipartUpload returns the UploadId", async () => {
    const send = vi.fn().mockResolvedValue({ UploadId: "up-1" });
    const { service } = makeService(send);
    await expect(service.createMultipartUpload("k", "audio/mp4")).resolves.toEqual({ uploadId: "up-1" });
    const cmd = send.mock.calls[0]![0] as CreateMultipartUploadCommand;
    expect(cmd.input).toEqual({ Bucket: "taken-rehearsal-dev", Key: "k", ContentType: "audio/mp4" });
  });

  it("presignUploadPart signs an UploadPartCommand with the given expiry", async () => {
    const { service, presign } = makeService(vi.fn());
    await expect(service.presignUploadPart("k", "up-1", 3, 3600)).resolves.toBe("https://signed");
    const [, cmd, opts] = presign.mock.calls[0]!;
    expect(cmd).toBeInstanceOf(UploadPartCommand);
    expect((cmd as UploadPartCommand).input).toEqual({ Bucket: "taken-rehearsal-dev", Key: "k", UploadId: "up-1", PartNumber: 3 });
    expect(opts).toEqual({ expiresIn: 3600 });
  });

  it("listParts follows pagination and strips quotes from ETags", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Parts: [{ PartNumber: 1, ETag: '"e1"' }], IsTruncated: true, NextPartNumberMarker: 1 })
      .mockResolvedValueOnce({ Parts: [{ PartNumber: 2, ETag: '"e2"' }], IsTruncated: false });
    const { service } = makeService(send);
    await expect(service.listParts("k", "up-1")).resolves.toEqual([
      { partNumber: 1, etag: "e1" },
      { partNumber: 2, etag: "e2" },
    ]);
    const second = send.mock.calls[1]![0] as ListPartsCommand;
    expect(second.input.PartNumberMarker).toBe("1");
  });

  it("completeMultipartUpload sends parts sorted by number", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await service.completeMultipartUpload("k", "up-1", [
      { partNumber: 2, etag: "e2" },
      { partNumber: 1, etag: "e1" },
    ]);
    const cmd = send.mock.calls[0]![0] as CompleteMultipartUploadCommand;
    expect(cmd.input.MultipartUpload).toEqual({
      Parts: [
        { PartNumber: 1, ETag: "e1" },
        { PartNumber: 2, ETag: "e2" },
      ],
    });
  });

  it("presignGet signs a GetObjectCommand", async () => {
    const { service, presign } = makeService(vi.fn());
    await service.presignGet("k", 60);
    expect(presign.mock.calls[0]![1]).toBeInstanceOf(GetObjectCommand);
  });

  it("deleteObjects is a no-op for an empty list and batches otherwise", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await service.deleteObjects([]);
    expect(send).not.toHaveBeenCalled();
    await service.deleteObjects(["a", "b"]);
    const cmd = send.mock.calls[0]![0] as DeleteObjectsCommand;
    expect(cmd.input.Delete).toEqual({ Objects: [{ Key: "a" }, { Key: "b" }], Quiet: true });
  });
});
