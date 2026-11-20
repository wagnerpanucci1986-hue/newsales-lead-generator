import { ImportStatus, type InstagramProfile } from '@prisma/client';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { upsertProspects, type ProspectCandidate } from '../lib/prospects.js';

export const INSTAGRAM_CONSENT_SOURCE = 'Perfil comercial público do Instagram (contato divulgado na bio) — prospecção B2B';

export function contactFromInstagram(p: InstagramProfile): ProspectCandidate | null {
  const phone = p.phones[0];
  if (!phone) return null;
  const customFields: Record<string, string> = { instagram: `@${p.username}` };
  if (p.followersCount !== null) customFields.seguidores = p.followersCount.toLocaleString('pt-BR');
  if (p.website) customFields.site = p.website;
  return { phone, name: p.name || p.username, company: p.name || null, email: p.emails[0] ?? null, customFields };
}

/** Leva perfis já pesquisados para Contatos (só os que têm telefone na bio ou no link). */
export async function runInstagramToContacts(importJobId: string): Promise<void> {
  const job = await prisma.importJob.findUnique({ where: { id: importJobId } });
  if (!job || job.status !== ImportStatus.PROCESSING) return;
  const usernames = (job.columnMapping as { instagram?: { usernames?: string[] } } | null)?.instagram?.usernames ?? [];
  try {
    const profiles = await prisma.instagramProfile.findMany({ where: { username: { in: usernames }, error: null } });
    const candidates = profiles.map(contactFromInstagram).filter((c): c is ProspectCandidate => !!c);
    const { created, updated, blacklisted } = await upsertProspects(job, candidates);
    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: ImportStatus.COMPLETED, totalRows: usernames.length, created, updated, invalid: usernames.length - candidates.length, blacklisted, finishedAt: new Date() },
    });
    logger.info({ importJobId, perfis: usernames.length, created, updated, blacklisted }, 'perfis do Instagram importados');
  } catch (err) {
    logger.error({ err, importJobId }, 'falha ao importar perfis do Instagram');
    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: ImportStatus.FAILED, error: (err instanceof Error ? err.message : String(err)).slice(0, 300), finishedAt: new Date() },
    });
  }
  await publishEvent({ type: 'import.updated', payload: { importId: importJobId, status: 'done' } });
}
