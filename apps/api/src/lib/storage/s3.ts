import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import type { Storage, StoredObject } from './index.js';

/** S3 ou compatível (MinIO): defina S3_ENDPOINT e S3_FORCE_PATH_STYLE=true para MinIO. */
export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
      throw new Error('STORAGE_DRIVER=s3 exige S3_BUCKET, S3_ACCESS_KEY e S3_SECRET_KEY');
    }
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    });
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mimeType }));
  }

  async get(key: string): Promise<StoredObject> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { stream: res.Body as Readable, size: res.ContentLength };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
