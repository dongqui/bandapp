import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { Provider } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { UploadedPart } from "@bandapp/types";

export abstract class StorageService {
  abstract createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  abstract presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresSec: number,
  ): Promise<string>;
  abstract listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  abstract completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abstract abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  abstract presignGet(key: string, expiresSec: number): Promise<string>;
  abstract downloadToFile(key: string, path: string): Promise<void>;
  abstract putFile(key: string, path: string, contentType: string): Promise<void>;
  abstract deleteObjects(keys: string[]): Promise<void>;
}

/**
 * R2는 S3 호환이지만 최신 AWS SDK가 기본으로 붙이는 CRC 체크섬 헤더를 거부한다.
 * 두 옵션을 WHEN_REQUIRED로 내리면 presigned PUT과 PutObject가 R2에서 그대로 동작한다.
 */
export function r2ClientConfig(env: NodeJS.ProcessEnv): S3ClientConfig & { endpoint: string } {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY must be set");
  }
  return {
    region: "auto",
    endpoint: env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
}

type Presign = typeof getSignedUrl;

export class R2StorageService extends StorageService {
  private client: S3Client | null = null;

  constructor(
    private readonly createClient: () => S3Client = () => new S3Client(r2ClientConfig(process.env)),
    private readonly presign: Presign = getSignedUrl,
  ) {
    super();
  }

  private get s3(): S3Client {
    this.client ??= this.createClient();
    return this.client;
  }

  private get bucket(): string {
    const bucket = process.env.R2_BUCKET;
    if (!bucket) throw new Error("R2_BUCKET is not set");
    return bucket;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const res = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error("CreateMultipartUpload returned no UploadId");
    return { uploadId: res.UploadId };
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSec: number): Promise<string> {
    return this.presign(
      this.s3,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: expiresSec },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await this.s3.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber !== undefined && p.ETag) parts.push({ partNumber: p.PartNumber, etag: stripQuotes(p.ETag) });
      }
      marker = res.IsTruncated && res.NextPartNumberMarker !== undefined ? String(res.NextPartNumberMarker) : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }

  presignGet(key: string, expiresSec: number): Promise<string> {
    return this.presign(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresSec,
    });
  }

  async downloadToFile(key: string, path: string): Promise<void> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`GetObject returned no body for ${key}`);
    await pipeline(res.Body as Readable, createWriteStream(path));
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const { size } = await stat(path);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  async deleteObjects(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}

function stripQuotes(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

export const storageServiceProvider: Provider = {
  provide: StorageService,
  useFactory: () => new R2StorageService(),
};
