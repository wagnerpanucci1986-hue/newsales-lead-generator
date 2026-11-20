import type { InstagramProfile } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { extractContacts } from './extract.js';
import { businessDiscovery, GraphError } from './graph.js';

/** Perfis consultados há menos que isso vêm do cache, sem gastar consulta na Meta. */
export const CACHE_DAYS = 7;
export const MAX_LOOKUP = 30;

export interface LookupResult {
  profiles: InstagramProfile[];
  /** Não consultados porque a Meta limitou as consultas ou o token falhou. */
  pending: string[];
  stopReason: string | null;
}

/**
 * Consulta perfis comerciais do Instagram pelo @, um por vez e com pausa curta entre eles.
 * Perfil inexistente ou pessoal fica gravado com o erro (para não consultar de novo à toa).
 * Limite da Meta ou token inválido interrompem o lote: o resto volta em `pending`.
 */
export async function lookupProfiles(usernames: string[], opts: { force?: boolean; pauseMs?: number } = {}): Promise<LookupResult> {
  const since = new Date(Date.now() - CACHE_DAYS * 86_400_000);
  const cached = opts.force ? [] : await prisma.instagramProfile.findMany({ where: { username: { in: usernames }, fetchedAt: { gte: since } } });
  const byName = new Map(cached.map((p) => [p.username, p]));
  const pending: string[] = [];
  let stopReason: string | null = null;

  for (const username of usernames) {
    if (byName.has(username)) continue;
    if (stopReason) {
      pending.push(username);
      continue;
    }
    try {
      const d = await businessDiscovery(username);
      const { phones, emails } = extractContacts(d.biography, d.website);
      const lastPost = d.media?.data?.[0]?.timestamp;
      const data = {
        igId: d.id,
        name: d.name ?? null,
        biography: d.biography ?? null,
        website: d.website ?? null,
        followersCount: d.followers_count ?? null,
        followsCount: d.follows_count ?? null,
        mediaCount: d.media_count ?? null,
        profilePictureUrl: d.profile_picture_url ?? null,
        lastPostAt: lastPost ? new Date(lastPost) : null,
        phones,
        emails,
        error: null,
        fetchedAt: new Date(),
      };
      byName.set(username, await prisma.instagramProfile.upsert({ where: { username }, create: { username, ...data }, update: data }));
    } catch (err) {
      if (err instanceof GraphError && err.kind === 'not_found') {
        const data = { error: err.message, fetchedAt: new Date(), phones: [], emails: [] };
        byName.set(username, await prisma.instagramProfile.upsert({ where: { username }, create: { username, ...data }, update: data }));
      } else {
        stopReason = err instanceof Error ? err.message : String(err);
        logger.warn({ username, reason: stopReason }, 'pesquisa no Instagram interrompida');
        pending.push(username);
      }
    }
    if (opts.pauseMs !== 0) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 400));
  }
  return { profiles: usernames.map((u) => byName.get(u)).filter((p): p is InstagramProfile => !!p), pending, stopReason };
}
