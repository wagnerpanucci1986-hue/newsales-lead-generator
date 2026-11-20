import type { ImportJob, Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

/** Um lead de captação pronto para virar contato (telefone já normalizado). */
export interface ProspectCandidate {
  phone: string;
  name: string | null;
  company: string | null;
  email: string | null;
  customFields: Record<string, string>;
}

/**
 * Grava leads de captação (CNPJ, Instagram) em Contatos, em lotes de 500:
 * novos são criados; existentes só têm campos vazios completados (nada que alguém
 * editou é sobrescrito); quem está na lista de bloqueio fica de fora. Aplica a lista
 * e as etiquetas do ImportJob. Telefone repetido conta uma vez só.
 */
export async function upsertProspects(job: Pick<ImportJob, 'listId' | 'tagIds' | 'consentSource'>, all: ProspectCandidate[]) {
  let created = 0;
  let updated = 0;
  let blacklisted = 0;
  for (let i = 0; i < all.length; i += 500) {
    const candidates = new Map<string, ProspectCandidate>();
    for (const c of all.slice(i, i + 500)) if (!candidates.has(c.phone)) candidates.set(c.phone, c);
    const phones = [...candidates.keys()];
    const [existing, blocked] = await Promise.all([
      prisma.contact.findMany({ where: { phone: { in: phones } }, select: { id: true, phone: true, name: true, company: true, email: true, customFields: true } }),
      prisma.blacklistEntry.findMany({ where: { phone: { in: phones } }, select: { phone: true } }),
    ]);
    const blockedSet = new Set(blocked.map((b) => b.phone));
    const existingByPhone = new Map(existing.map((c) => [c.phone, c]));

    const fresh = [...candidates.values()].filter((c) => !existingByPhone.has(c.phone) && !blockedSet.has(c.phone));
    blacklisted += phones.filter((p) => blockedSet.has(p)).length;
    if (fresh.length) {
      await prisma.contact.createMany({
        data: fresh.map((c) => ({ phone: c.phone, name: c.name, company: c.company, email: c.email, customFields: c.customFields, consentSource: job.consentSource })),
        skipDuplicates: true,
      });
      created += fresh.length;
    }
    for (const current of existing) {
      if (blockedSet.has(current.phone)) continue;
      const c = candidates.get(current.phone)!;
      const data: Prisma.ContactUpdateInput = {
        customFields: { ...c.customFields, ...((current.customFields as Record<string, string>) ?? {}) },
      };
      if (!current.name && c.name) data.name = c.name;
      if (!current.company && c.company) data.company = c.company;
      if (!current.email && c.email) data.email = c.email;
      await prisma.contact.update({ where: { id: current.id }, data });
      updated++;
    }
    const ids = (await prisma.contact.findMany({ where: { phone: { in: phones.filter((p) => !blockedSet.has(p)) } }, select: { id: true } })).map((c) => c.id);
    if (job.listId) await prisma.contactListMember.createMany({ data: ids.map((contactId) => ({ contactId, listId: job.listId! })), skipDuplicates: true });
    for (const tagId of job.tagIds) await prisma.contactTag.createMany({ data: ids.map((contactId) => ({ contactId, tagId })), skipDuplicates: true });
  }
  return { created, updated, blacklisted };
}
