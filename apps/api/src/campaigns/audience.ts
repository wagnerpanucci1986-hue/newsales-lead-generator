import { CampaignStatus, RecipientStatus, WaCheckStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export const audienceFilterSchema = z.object({
  /** contatos com QUALQUER uma destas etiquetas */
  tagIds: z.array(z.string()).max(20).default([]),
  /** só quem já foi confirmado no WhatsApp */
  onlyWaValid: z.boolean().default(false),
});
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;

/** Público = membros das listas escolhidas, restrito às etiquetas (se houver). Exige lista ou etiqueta. */
export function audienceWhere(listIds: string[], filter: AudienceFilter): Prisma.ContactWhereInput | null {
  if (!listIds.length && !filter.tagIds.length) return null;
  return {
    AND: [
      listIds.length ? { lists: { some: { listId: { in: listIds } } } } : {},
      filter.tagIds.length ? { tags: { some: { tagId: { in: filter.tagIds } } } } : {},
    ],
  };
}

/** Por que um contato do público não vai receber (null = vai receber). */
function skipReason(c: { optedOutAt: Date | null; waStatus: WaCheckStatus }, blocked: boolean, filter: AudienceFilter): string | null {
  if (blocked) return 'blacklist';
  if (c.optedOutAt) return 'opt-out';
  if (c.waStatus === WaCheckStatus.INVALID) return 'sem WhatsApp';
  if (filter.onlyWaValid && c.waStatus !== WaCheckStatus.VALID) return 'WhatsApp não verificado';
  return null;
}

/** Tamanho do público e quantos seriam pulados, sem gravar nada (prévia no painel). */
export async function previewAudience(listIds: string[], filterInput: unknown) {
  const filter = audienceFilterSchema.parse(filterInput ?? {});
  const where = audienceWhere(listIds, filter);
  if (!where) return { total: 0, willSend: 0, skipped: {} as Record<string, number> };
  const skipped: Record<string, number> = {};
  let total = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.contact.findMany({
      where,
      orderBy: { id: 'asc' },
      take: 2000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, phone: true, optedOutAt: true, waStatus: true },
    });
    if (!batch.length) break;
    cursor = batch.at(-1)!.id;
    total += batch.length;
    const blocked = new Set((await prisma.blacklistEntry.findMany({ where: { phone: { in: batch.map((c) => c.phone) } }, select: { phone: true } })).map((b) => b.phone));
    for (const c of batch) {
      const reason = skipReason(c, blocked.has(c.phone), filter);
      if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    }
  }
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  return { total, willSend: total - skippedTotal, skipped };
}

/**
 * Início da campanha: grava um destinatário por contato do público. Quem está na
 * blacklist, pediu para sair ou não tem WhatsApp já entra como SKIPPED, com o motivo.
 */
export async function startCampaign(campaignId: string): Promise<void> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { lists: true } });
  if (!campaign || campaign.status !== CampaignStatus.SCHEDULED) return;

  const filter = audienceFilterSchema.parse(campaign.audienceFilter ?? {});
  const where = audienceWhere(campaign.lists.map((l) => l.listId), filter);
  let total = 0;
  let queued = 0;
  if (where) {
    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.contact.findMany({
        where,
        orderBy: { id: 'asc' },
        take: 1000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, phone: true, optedOutAt: true, waStatus: true },
      });
      if (!batch.length) break;
      cursor = batch.at(-1)!.id;
      const blocked = new Set((await prisma.blacklistEntry.findMany({ where: { phone: { in: batch.map((c) => c.phone) } }, select: { phone: true } })).map((b) => b.phone));
      const data = batch.map((c) => {
        const reason = skipReason(c, blocked.has(c.phone), filter);
        if (!reason) queued++;
        return { campaignId, contactId: c.id, status: reason ? RecipientStatus.SKIPPED : RecipientStatus.QUEUED, skipReason: reason };
      });
      total += (await prisma.campaignRecipient.createMany({ data, skipDuplicates: true })).count;
    }
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      totalRecipients: total,
      startedAt: new Date(),
      status: queued ? CampaignStatus.RUNNING : CampaignStatus.COMPLETED,
      finishedAt: queued ? null : new Date(),
    },
  });
  logger.info({ campaignId, total, queued }, 'campanha iniciada');
  await publishEvent({ type: 'campaign.updated', payload: { campaignId } });
}

/** Números do relatório, sempre contados nos destinatários. */
export async function campaignStats(campaignIds: string[]) {
  const empty = () => ({ total: 0, queued: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, replied: 0, optOut: 0 });
  const stats = new Map(campaignIds.map((id) => [id, empty()]));
  if (!campaignIds.length) return stats;
  const where = { campaignId: { in: campaignIds } };
  const [byStatus, delivered, read, replied, optOut] = await Promise.all([
    prisma.campaignRecipient.groupBy({ by: ['campaignId', 'status'], where, _count: true }),
    prisma.campaignRecipient.groupBy({ by: ['campaignId'], where: { ...where, deliveredAt: { not: null } }, _count: true }),
    prisma.campaignRecipient.groupBy({ by: ['campaignId'], where: { ...where, readAt: { not: null } }, _count: true }),
    prisma.campaignRecipient.groupBy({ by: ['campaignId'], where: { ...where, repliedAt: { not: null } }, _count: true }),
    prisma.campaignRecipient.groupBy({ by: ['campaignId'], where: { ...where, optedOutAt: { not: null } }, _count: true }),
  ]);
  for (const row of byStatus) {
    const s = stats.get(row.campaignId)!;
    s.total += row._count;
    if (row.status === 'QUEUED') s.queued = row._count;
    else if (row.status === 'SENDING') s.sending = row._count;
    else if (row.status === 'FAILED') s.failed = row._count;
    else if (row.status === 'SKIPPED') s.skipped = row._count;
    else s.sent += row._count; // SENT, DELIVERED e READ foram todas enviadas
  }
  for (const r of delivered) stats.get(r.campaignId)!.delivered = r._count;
  for (const r of read) stats.get(r.campaignId)!.read = r._count;
  for (const r of replied) stats.get(r.campaignId)!.replied = r._count;
  for (const r of optOut) stats.get(r.campaignId)!.optOut = r._count;
  return stats;
}
