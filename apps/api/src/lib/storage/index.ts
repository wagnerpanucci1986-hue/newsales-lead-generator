import type { Readable } from 'node:stream';
import { env } from '../../config/env.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export interface StoredObject {
  stream: Readable;
  size?: number;
}

/** Armazenamento de mídia. A chave é um caminho relativo (ex.: "numId/2026-11/abc.jpg"). */
export interface Storage {
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

export const storage: Storage = env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(env.STORAGE_LOCAL_PATH);
