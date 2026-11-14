import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

/** Conexão compartilhada para comandos comuns (publish, get/set). */
export const redis = createRedis();

/** Opções de conexão no formato aceito pelo BullMQ (ele cria as próprias conexões). */
export function bullConnection() {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
