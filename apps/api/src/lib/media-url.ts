import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

// URLs de mídia assinadas e com validade: <img>, <audio> e <video> não enviam o
// cabeçalho Authorization, então a própria URL carrega a autorização.
const TTL_S = 6 * 60 * 60;

const sign = (mediaId: string, exp: number) => createHmac('sha256', env.JWT_SECRET).update(`media:${mediaId}:${exp}`).digest('base64url');

export function signedMediaPath(mediaId: string): string {
  // Validade arredondada para a hora: a URL fica estável e o navegador aproveita o cache.
  const exp = Math.ceil((Date.now() / 1000 + TTL_S) / 3600) * 3600;
  return `/api/media/${mediaId}?exp=${exp}&sig=${sign(mediaId, exp)}`;
}

export function verifyMediaSignature(mediaId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(mediaId, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
