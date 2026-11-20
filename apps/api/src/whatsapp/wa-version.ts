import { fetchLatestBaileysVersion, fetchLatestWaWebVersion, type WAVersion } from 'baileys';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// O WhatsApp encerra a conexão (códigos 405/428, antes do QR) quando o cliente
// informa uma versão antiga do WhatsApp Web. A versão embutida na biblioteca
// envelhece, então buscamos a atual a cada conexão, com cache.
const CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

let cached: { version: WAVersion; source: string; at: number } | null = null;

const withTimeout = <T>(p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tempo esgotado')), TIMEOUT_MS))]);

function parseOverride(value: string | undefined): WAVersion | null {
  const m = value?.trim().match(/^(\d+)[.,](\d+)[.,](\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Versão do WhatsApp Web a anunciar. Ordem: WA_VERSION do .env (emergência) →
 * versão publicada pelo WhatsApp Web → versão publicada pela biblioteca → embutida.
 * `fresh` ignora o cache (usado quando o servidor acabou de recusar a conexão).
 */
export async function getWaVersion(fresh = false): Promise<{ version: WAVersion | undefined; source: string }> {
  const override = parseOverride(env.WA_VERSION);
  if (override) return { version: override, source: 'WA_VERSION do .env' };
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached;

  try {
    const web = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (web.isLatest) {
      cached = { version: web.version, source: 'WhatsApp Web', at: Date.now() };
      return cached;
    }
    logger.warn({ err: web.error }, 'não foi possível ler a versão do WhatsApp Web');
  } catch (err) {
    logger.warn({ err }, 'não foi possível ler a versão do WhatsApp Web');
  }
  try {
    const lib = await withTimeout(fetchLatestBaileysVersion());
    if (lib.isLatest) {
      cached = { version: lib.version, source: 'repositório da biblioteca', at: Date.now() };
      return cached;
    }
  } catch (err) {
    logger.warn({ err }, 'não foi possível ler a versão publicada pela biblioteca');
  }
  // undefined = a biblioteca usa a versão embutida dela.
  return { version: undefined, source: 'embutida na biblioteca' };
}
