import { ImportStatus } from '@prisma/client';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { upsertProspects, type ProspectCandidate } from '../lib/prospects.js';
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
    let noPhone = 0;
    const candidates: ProspectCandidate[] = [];
    for (const r of rows) {
      const c = contactFromCnpj(r, opts.includeFixed);
      if (c) candidates.push(c);
      else noPhone++;
    }
    const { created, updated, blacklisted } = await upsertProspects(job, candidates);

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
