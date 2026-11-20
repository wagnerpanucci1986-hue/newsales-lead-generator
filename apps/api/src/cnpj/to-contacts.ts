import { ImportStatus, type Prisma } from '@prisma/client';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { formatCnpj, PORTE_LABEL, titleCase } from './layout.js';
import { cnpjFiltersSchema, selectForImport, type CnpjResult } from './search.js';

export const CNPJ_CONSENT_SOURCE = 'Base pública de CNPJ (Receita Federal) — prospecção B2B';

/** Razão social de MEI vem como "12.345.678 FULANO DE TAL": tira o número da frente. */
const stripMeiPrefix = (name: string) => name.replace(/^[\d.\s-]{8,}/, '').trim();

export function contactFromCnpj(r: CnpjResult, includeFixed: boolean) {
  const phone = r.mobile ?? (includeFixed ? r.phone : null);
  if (!phone) return null;
  const razao = r.razaoSocial ? titleCase(stripMeiPrefix(r.razaoSocial)) : null;
  const name = r.nomeFantasia ? titleCase(r.nomeFantasia) : razao;
  const customFields: Record<string, string> = {
    cnpj: formatCnpj(r.cnpj),
    cnae: [r.cnaePrincipal, r.cnaeDescricao].filter(Boolean).join(' — '),
    cidade: r.municipio ? titleCase(r.municipio) : '',
    uf: r.uf,
    bairro: r.bairro ? titleCase(r.bairro) : '',
    porte: r.isMei ? 'MEI' : (PORTE_LABEL[r.porte ?? ''] ?? ''),
    capital_social: r.capitalSocial !== null ? r.capitalSocial.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '',
    tipo: r.isMatriz ? 'Matriz' : 'Filial',
  };
  for (const k of Object.keys(customFields)) if (!customFields[k]) delete customFields[k];
  return { phone, name, company: razao, email: r.email, customFields };
}

interface CnpjImportOptions {
  filters: unknown;
  cnpjs?: string[];
  limit: number;
  includeFixed: boolean;
}

/** Leva empresas da base de CNPJ para Contatos, com etiquetas e lista do ImportJob. */
export async function runCnpjToContacts(importJobId: string): Promise<void> {
  const job = await prisma.importJob.findUnique({ where: { id: importJobId } });
  if (!job || job.status !== ImportStatus.PROCESSING) return;
  const opts = (job.columnMapping as { cnpj?: CnpjImportOptions } | null)?.cnpj;
  try {
    if (!opts) throw new Error('importação sem parâmetros');
    const rows = await selectForImport(cnpjFiltersSchema.parse(opts.filters), { cnpjs: opts.cnpjs, limit: opts.limit });
    let created = 0;
    let updated = 0;
    let noPhone = 0;
    let blacklisted = 0;
    const ids: string[] = [];

    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const candidates = new Map<string, NonNullable<ReturnType<typeof contactFromCnpj>>>();
      for (const r of chunk) {
        const c = contactFromCnpj(r, opts.includeFixed);
        if (!c) noPhone++;
        else if (!candidates.has(c.phone)) candidates.set(c.phone, c); // matriz e filial com o mesmo telefone
      }
      const phones = [...candidates.keys()];
      const [existing, blocked] = await Promise.all([
        prisma.contact.findMany({ where: { phone: { in: phones } }, select: { id: true, phone: true, name: true, company: true, email: true, customFields: true } }),
        prisma.blacklistEntry.findMany({ where: { phone: { in: phones } }, select: { phone: true } }),
      ]);
      const blockedSet = new Set(blocked.map((b) => b.phone));
      const existingByPhone = new Map(existing.map((c) => [c.phone, c]));

      const fresh = [...candidates.values()].filter((c) => !existingByPhone.has(c.phone) && !blockedSet.has(c.phone));
      blacklisted += [...candidates.keys()].filter((p) => blockedSet.has(p)).length;
      if (fresh.length) {
        await prisma.contact.createMany({
          data: fresh.map((c) => ({ phone: c.phone, name: c.name, company: c.company, email: c.email, customFields: c.customFields, consentSource: job.consentSource })),
          skipDuplicates: true,
        });
        created += fresh.length;
      }
      // Já existentes: completa só o que estiver vazio, sem sobrescrever o que alguém editou.
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
      const chunkIds = (await prisma.contact.findMany({ where: { phone: { in: phones.filter((p) => !blockedSet.has(p)) } }, select: { id: true } })).map((c) => c.id);
      ids.push(...chunkIds);
      if (job.listId) await prisma.contactListMember.createMany({ data: chunkIds.map((contactId) => ({ contactId, listId: job.listId! })), skipDuplicates: true });
      for (const tagId of job.tagIds) await prisma.contactTag.createMany({ data: chunkIds.map((contactId) => ({ contactId, tagId })), skipDuplicates: true });
    }

    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: ImportStatus.COMPLETED, totalRows: rows.length, created, updated, invalid: noPhone, blacklisted, finishedAt: new Date() },
    });
    logger.info({ importJobId, rows: rows.length, created, updated, noPhone, blacklisted }, 'empresas da base de CNPJ importadas');
  } catch (err) {
    logger.error({ err, importJobId }, 'falha ao importar empresas da base de CNPJ');
    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: ImportStatus.FAILED, error: (err instanceof Error ? err.message : String(err)).slice(0, 300), finishedAt: new Date() },
    });
  }
  await publishEvent({ type: 'import.updated', payload: { importId: importJobId, status: 'done' } });
}
