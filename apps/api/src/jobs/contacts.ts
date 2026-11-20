import { ImportStatus, WaCheckStatus, type Prisma } from '@prisma/client';
import { Worker } from 'bullmq';
import type { Readable } from 'node:stream';
import { runCnpjToContacts } from '../cnpj/to-contacts.js';
import { runInstagramToContacts } from '../instagram/to-contacts.js';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { prisma } from '../lib/prisma.js';
import { contactsQueue, QUEUE_CONTACTS, type ContactsJob } from '../lib/queues.js';
import { bullConnection } from '../lib/redis.js';
import { parseSpreadsheet } from '../lib/spreadsheet.js';
import { storage } from '../lib/storage/index.js';
import { brPhoneVariants } from '../whatsapp/jid.js';
import type { SocketProvider } from '../whatsapp/sender.js';


interface ParsedRow {
  phone: string;
  name?: string;
  company?: string;
  email?: string;
  custom: Record<string, string>;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** Importa a planilha: valida e normaliza telefones, deduplica e grava em lotes. */
export async function runImport(importId: string): Promise<void> {
  const job = await prisma.importJob.findUnique({ where: { id: importId } });
  if (!job || job.status !== ImportStatus.PROCESSING) return;
  const options = (job.columnMapping ?? {}) as { columns?: Record<string, string>; verifyNumberId?: string | null };
  const mapping = options.columns ?? {};

  try {
    const sheet = await parseSpreadsheet(await readAll((await storage.get(job.storageKey)).stream), job.fileName);
    const targets = sheet.headers.map((h) => mapping[h] ?? 'ignore');

    // 1) Validação e deduplicação dentro do arquivo (a última ocorrência vale).
    const byPhone = new Map<string, ParsedRow>();
    const rejected: { line: number; value: string; reason: string }[] = [];
    let invalid = 0;
    let duplicated = 0;
    sheet.rows.forEach((cells, index) => {
      const row: ParsedRow = { phone: '', custom: {} };
      let rawPhone = '';
      targets.forEach((target, col) => {
        const value = (cells[col] ?? '').trim();
        if (!value || target === 'ignore') return;
        if (target === 'phone') rawPhone = value;
        else if (target === 'name') row.name = value.slice(0, 120);
        else if (target === 'company') row.company = value.slice(0, 120);
        else if (target === 'email') row.email = value.slice(0, 200);
        else if (target.startsWith('custom:')) row.custom[target.slice(7)] = value.slice(0, 500);
      });
      const phone = normalizePhone(rawPhone);
      if (!phone.ok) {
        invalid++;
        if (rejected.length < 50) rejected.push({ line: index + 2, value: rawPhone, reason: phone.reason });
        return;
      }
      if (byPhone.has(phone.phone)) duplicated++;
      row.phone = phone.phone;
      byPhone.set(phone.phone, row);
    });

    // 2) Gravação em lotes: cria os novos, atualiza os existentes (sem apagar dados com células vazias).
    const rows = [...byPhone.values()];
    const now = new Date();
    let created = 0;
    let updated = 0;
    let blacklisted = 0;
    const importedIds: string[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const phones = chunk.map((r) => r.phone);
      const [existing, blocked] = await Promise.all([
        prisma.contact.findMany({ where: { phone: { in: phones } }, select: { id: true, phone: true, customFields: true } }),
        prisma.blacklistEntry.count({ where: { phone: { in: phones } } }),
      ]);
      blacklisted += blocked;
      const existingByPhone = new Map(existing.map((c) => [c.phone, c]));

      const fresh = chunk.filter((r) => !existingByPhone.has(r.phone));
      if (fresh.length) {
        await prisma.contact.createMany({
          data: fresh.map((r) => ({
            phone: r.phone,
            name: r.name ?? null,
            company: r.company ?? null,
            email: r.email ?? null,
            customFields: r.custom,
            consentSource: job.consentSource,
            consentAt: job.consentSource ? now : null,
          })),
          skipDuplicates: true,
        });
        created += fresh.length;
      }
      for (const r of chunk) {
        const current = existingByPhone.get(r.phone);
        if (!current) continue;
        const data: Prisma.ContactUpdateInput = {};
        if (r.name) data.name = r.name;
        if (r.company) data.company = r.company;
        if (r.email) data.email = r.email;
        if (Object.keys(r.custom).length) data.customFields = { ...((current.customFields as Record<string, string>) ?? {}), ...r.custom };
        if (job.consentSource) Object.assign(data, { consentSource: job.consentSource, consentAt: now });
        if (Object.keys(data).length) await prisma.contact.update({ where: { id: current.id }, data });
        updated++;
      }

      const ids = (await prisma.contact.findMany({ where: { phone: { in: phones } }, select: { id: true } })).map((c) => c.id);
      importedIds.push(...ids);
      if (job.listId) await prisma.contactListMember.createMany({ data: ids.map((contactId) => ({ contactId, listId: job.listId! })), skipDuplicates: true });
      for (const tagId of job.tagIds) {
        await prisma.contactTag.createMany({ data: ids.map((contactId) => ({ contactId, tagId })), skipDuplicates: true }).catch(() => undefined); // etiqueta apagada no meio do caminho
      }
    }

    await prisma.importJob.update({
      where: { id: importId },
      data: { status: ImportStatus.COMPLETED, created, updated, invalid, blacklisted, errorReport: { rejected, duplicatedInFile: duplicated }, finishedAt: new Date() },
    });
    await publishEvent({ type: 'import.updated', payload: { importId, status: ImportStatus.COMPLETED } });
    logger.info({ importId, created, updated, invalid, duplicated }, 'importação concluída');

    if (options.verifyNumberId && importedIds.length) {
      for (let i = 0; i < importedIds.length; i += 2000) {
        await contactsQueue.add('verify', { kind: 'verify', numberId: options.verifyNumberId, contactIds: importedIds.slice(i, i + 2000) });
      }
    }
  } catch (err) {
    logger.error({ err, importId }, 'importação falhou');
    await prisma.importJob.update({
      where: { id: importId },
      data: { status: ImportStatus.FAILED, error: (err instanceof Error ? err.message : 'erro desconhecido').slice(0, 300), finishedAt: new Date() },
    });
    await publishEvent({ type: 'import.updated', payload: { importId, status: ImportStatus.FAILED } });
  }
}

const VERIFY_BATCH = 25;

/**
 * Pergunta ao WhatsApp quais telefones têm conta. Consultas em massa são, por si
 * só, um sinal de risco para o número que pergunta: lotes pequenos e espaçados.
 */
export async function runVerify(
  sessions: SocketProvider,
  data: Extract<ContactsJob, { kind: 'verify' }>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ valid: number; invalid: number }> {
  const where: Prisma.ContactWhereInput = {
    waStatus: WaCheckStatus.UNKNOWN,
    ...(data.contactIds ? { id: { in: data.contactIds } } : {}),
    ...(data.listId ? { lists: { some: { listId: data.listId } } } : {}),
  };
  let valid = 0;
  let invalid = 0;
  for (;;) {
    const sock = sessions.getSocket(data.numberId);
    if (!sock?.user) {
      logger.warn({ numberId: data.numberId }, 'verificação interrompida: número desconectado');
      break;
    }
    const batch = await prisma.contact.findMany({ where, take: VERIFY_BATCH, orderBy: { id: 'asc' }, select: { id: true, phone: true } });
    if (!batch.length) break;

    const results = (await sock.onWhatsApp(...batch.map((c) => c.phone))) ?? [];
    const jidByUser = new Map(results.filter((r) => r.exists).map((r) => [r.jid.split('@')[0]!.split(':')[0]!, r.jid]));
    const now = new Date();
    for (const c of batch) {
      // A conta pode existir com ou sem o 9º dígito; o JID devolvido é o que vale para envio.
      const jid = brPhoneVariants(c.phone).map((v) => jidByUser.get(v)).find(Boolean);
      await prisma.contact.update({
        where: { id: c.id },
        data: { waStatus: jid ? WaCheckStatus.VALID : WaCheckStatus.INVALID, waJid: jid ?? null, waCheckedAt: now },
      });
      if (jid) valid++;
      else invalid++;
    }
    if (batch.length < VERIFY_BATCH) break;
    await sleep(4_000 + Math.random() * 4_000);
  }
  logger.info({ numberId: data.numberId, valid, invalid }, 'verificação de WhatsApp concluída');
  return { valid, invalid };
}

export function createContactsWorker(sessions: SocketProvider): Worker<ContactsJob> {
  const worker = new Worker<ContactsJob>(
    QUEUE_CONTACTS,
    async (job) => {
      if (job.data.kind === 'import') return runImport(job.data.importId);
      if (job.data.kind === 'cnpj-contacts') return runCnpjToContacts(job.data.importId);
      if (job.data.kind === 'instagram-contacts') return runInstagramToContacts(job.data.importId);
      await runVerify(sessions, job.data);
    },
    // Uma verificação por vez: duas em paralelo dobrariam o ritmo de consultas.
    { connection: bullConnection(), concurrency: 1, lockDuration: 120_000 },
  );
  worker.on('failed', (job, err) => logger.error({ err, job: job?.data.kind }, 'job de contatos falhou'));
  return worker;
}
