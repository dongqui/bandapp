import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { R2StorageService, r2ClientConfig } from "./storage.service.js";

function makeService(send: ReturnType<typeof vi.fn>, presign = vi.fn().mockResolvedValue("https://signed")) {
  process.env.R2_BUCKET = "taken-rehearsal-dev";
  const client = { send } as unknown as S3Client;
  return { service: new R2StorageService(() => client, presign), presign };
}

const tmpDirs: string[] = [];

afterEach(() => {
  delete process.env.R2_BUCKET;
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_ENDPOINT;
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
  it("rejects an R2_ENDPOINT with a path", () => {
    expect(() =>
      r2ClientConfig({
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "k",
        R2_SECRET_ACCESS_KEY: "s",
        R2_ENDPOINT: "https://x.example.com/bucket",
      } as NodeJS.ProcessEnv),
    ).toThrow("no path");
  });
  it("accepts an R2_ENDPOINT that is a bare origin, with or without a trailing slash", () => {
    for (const endpoint of ["https://x.example.com", "https://x.example.com/"]) {
      const config = r2ClientConfig({
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "k",
        R2_SECRET_ACCESS_KEY: "s",
        R2_ENDPOINT: endpoint,
      } as NodeJS.ProcessEnv);
      expect(config.endpoint).toBe(endpoint);
    }
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

  it("completeMultipartUpload sends parts sorted by number, with ETags re-quoted", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await service.completeMultipartUpload("k", "up-1", [
      { partNumber: 2, etag: "e2" },
      { partNumber: 1, etag: "e1" },
    ]);
    const cmd = send.mock.calls[0]![0] as CompleteMultipartUploadCommand;
    expect(cmd.input.MultipartUpload).toEqual({
      Parts: [
        { PartNumber: 1, ETag: '"e1"' },
        { PartNumber: 2, ETag: '"e2"' },
      ],
    });
  });

  it("completeMultipartUpload does not double-quote an already-quoted ETag", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await service.completeMultipartUpload("k", "up-1", [{ partNumber: 1, etag: '"e3"' }]);
    const cmd = send.mock.calls[0]![0] as CompleteMultipartUploadCommand;
    expect(cmd.input.MultipartUpload).toEqual({ Parts: [{ PartNumber: 1, ETag: '"e3"' }] });
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

  it("listKeys paginates and returns the concatenated keys under the prefix", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: "bands/b/sessions/s/takes/a.m4a" }, { Key: "bands/b/sessions/s/takes/b.m4a" }],
        IsTruncated: true,
        NextContinuationToken: "tok-1",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "bands/b/sessions/s/takes/c.m4a" }],
        IsTruncated: false,
      });
    const { service } = makeService(send);
    await expect(service.listKeys("bands/b/sessions/s/takes/")).resolves.toEqual([
      "bands/b/sessions/s/takes/a.m4a",
      "bands/b/sessions/s/takes/b.m4a",
      "bands/b/sessions/s/takes/c.m4a",
    ]);
    const first = send.mock.calls[0]![0] as ListObjectsV2Command;
    expect(first.input).toEqual({
      Bucket: "taken-rehearsal-dev",
      Prefix: "bands/b/sessions/s/takes/",
      ContinuationToken: undefined,
    });
    const second = send.mock.calls[1]![0] as ListObjectsV2Command;
    expect(second.input.ContinuationToken).toBe("tok-1");
  });

  it("abortMultipartUpload sends an AbortMultipartUploadCommand", async () => {
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await service.abortMultipartUpload("k", "up-1");
    const cmd = send.mock.calls[0]![0] as AbortMultipartUploadCommand;
    expect(cmd).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(cmd.input).toEqual({ Bucket: "taken-rehearsal-dev", Key: "k", UploadId: "up-1" });
  });

  it("downloadToFile writes the response body stream to the given path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-spec-"));
    tmpDirs.push(dir);
    const dest = join(dir, "out.txt");
    const send = vi.fn().mockResolvedValue({ Body: Readable.from([Buffer.from("hello")]) });
    const { service } = makeService(send);
    await service.downloadToFile("k", dest);
    expect(readFileSync(dest, "utf8")).toBe("hello");
  });

  it("downloadToFile rejects when the response has no body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-spec-"));
    tmpDirs.push(dir);
    const dest = join(dir, "out.txt");
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await expect(service.downloadToFile("k", dest)).rejects.toThrow();
  });

  it("putFile sends a PutObjectCommand streaming the file with its byte size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-spec-"));
    tmpDirs.push(dir);
    const src = join(dir, "in.mp4");
    const content = Buffer.from("audio-bytes");
    writeFileSync(src, content);
    const send = vi.fn().mockResolvedValue({});
    const { service } = makeService(send);
    await service.putFile("k", src, "audio/mp4");
    const cmd = send.mock.calls[0]![0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input.Bucket).toBe("taken-rehearsal-dev");
    expect(cmd.input.Key).toBe("k");
    expect(cmd.input.ContentType).toBe("audio/mp4");
    expect(cmd.input.ContentLength).toBe(content.byteLength);
    expect(cmd.input.Body).toBeInstanceOf(Readable);
    // send()가 목이라 스트림을 실제로 소비하지 않는다. 열린 채로 두면 afterEach가 임시 파일을
    // 지운 뒤 비동기 open()이 뒤늦게 완료되며 처리되지 않은 ENOENT를 던지므로 정리해 둔다.
    const body = cmd.input.Body as Readable;
    body.on("error", () => {});
    body.destroy();
  });
});
