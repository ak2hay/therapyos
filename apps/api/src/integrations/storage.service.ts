import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { env } from '../config/env';

/** S3-compatible object storage (AWS S3, R2, SeaweedFS, MinIO...) with a local-disk fallback. */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private s3?: S3Client;
  private readonly localRoot = join(process.cwd(), 'uploads');

  constructor() {
    const e = env();
    if (e.STORAGE_DRIVER === 's3') {
      this.s3 = new S3Client({
        region: e.S3_REGION,
        endpoint: e.S3_ENDPOINT || undefined,
        forcePathStyle: e.S3_FORCE_PATH_STYLE,
        credentials: e.S3_ACCESS_KEY ? { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY ?? '' } : undefined,
      });
    }
  }

  get driver() {
    return this.s3 ? 's3' : 'local';
  }

  async onModuleInit() {
    if (!this.s3) return;
    const Bucket = env().S3_BUCKET;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket }));
    } catch {
      try {
        await this.s3.send(new CreateBucketCommand({ Bucket }));
        this.logger.log(`Created bucket ${Bucket}`);
      } catch (err) {
        this.logger.warn(`Object storage unavailable, falling back to local disk: ${(err as Error).message}`);
        this.s3 = undefined;
      }
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
    } else {
      const path = join(this.localRoot, key);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, body);
    }
    return key;
  }

  async get(key: string): Promise<Buffer> {
    if (this.s3) {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
      const chunks: Buffer[] = [];
      for await (const chunk of out.Body as Readable) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    }
    return fs.readFile(join(this.localRoot, key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.get(key);
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, expiresIn = 600): Promise<string | null> {
    if (!this.s3) return null;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }), { expiresIn });
  }
}
