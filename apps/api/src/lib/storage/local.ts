import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Storage, StoredObject } from './index.js';

export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  // Impede que uma chave com ".." escape da pasta de mídia.
  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('chave de storage inválida');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async get(key: string): Promise<StoredObject> {
    const full = this.resolve(key);
    const info = await stat(full);
    return { stream: createReadStream(full), size: info.size };
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}
