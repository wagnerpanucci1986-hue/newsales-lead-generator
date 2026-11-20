import { ImportStatus, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation, prisma } from '../../lib/prisma.js';
import { contactsQueue } from '../../lib/queues.js';
import { parseSpreadsheet, suggestMapping } from '../../lib/spreadsheet.js';
import { storage } from '../../lib/storage/index.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const target = z.string().regex(/^(phone|name|company|email|ignore|custom:.{1,40})$/);
const startBody = z.object({
  mapping: z.record(z.string(), target),
  listId: z.string().nullish(),
  newListName: z.string().trim().min(1).max(80).nullish(),
  tagIds: z.array(z.string()).max(20).default([]),
  consentSource: z.string().trim().max(200).nullish(),
  // Número que fará a verificação "tem WhatsApp" depois de importar (opcional).
  verifyNumberId: z.string().nullish(),
});

/** Importação de contatos em dois passos: enviar o arquivo, depois mapear as colunas e iniciar. */
export async function importRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  app.post('/', async (req, reply) => {
    if (!req.isMultipart()) throw new HttpError(400, 'Envie o arquivo como multipart');
    const file = await req.file();
    if (!file) throw new HttpError(400, 'Envie um arquivo .csv ou .xlsx');
    const buffer = await file.toBuffer();
    const fileName = path.basename(file.filename || 'contatos.csv').slice(0, 200);
    const sheet = await parseSpreadsheet(buffer, fileName).catch((err: Error) => {
      throw new HttpError(400, err.message);
    });
    const storageKey = `importacoes/${randomUUID()}${path.extname(fileName).toLowerCase()}`;
    await storage.put(storageKey, buffer, file.mimetype);
    const job = await prisma.importJob.create({ data: { fileName, storageKey, totalRows: sheet.rows.length, createdById: req.user.id } });
    return reply.code(201).send({
      import: job,
      columns: sheet.headers,
      sample: sheet.rows.slice(0, 5),
      suggestedMapping: suggestMapping(sheet.headers),
    });
  });

  app.post('/:id/start', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = startBody.parse(req.body);
    const job = await prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new HttpError(404, 'Importação não encontrada');
    if (job.status !== ImportStatus.UPLOADED) throw new HttpError(409, 'Esta importação já foi iniciada');
    if (Object.values(b.mapping).filter((t) => t === 'phone').length !== 1) throw new HttpError(400, 'Escolha exatamente uma coluna como Telefone');

    let listId = b.listId ?? null;
    if (b.newListName) {
      try {
        listId = (await prisma.contactList.create({ data: { name: b.newListName } })).id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma lista com este nome');
        throw err;
      }
    }
    const updated = await prisma.importJob.update({
      where: { id },
      data: {
        status: ImportStatus.PROCESSING,
        // "verifyNumberId" viaja junto do mapeamento para o worker.
        columnMapping: { columns: b.mapping, verifyNumberId: b.verifyNumberId ?? null },
        listId,
        tagIds: b.tagIds,
        consentSource: b.consentSource || null,
        verifyWa: Boolean(b.verifyNumberId),
      },
    });
    await contactsQueue.add('import', { kind: 'import', importId: id });
    await audit({ userId: req.user.id, action: 'contact.import', entity: 'ImportJob', entityId: id, meta: { fileName: job.fileName, rows: job.totalRows }, ip: req.ip });
    return reply.code(202).send({ import: updated });
  });

  app.get('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await prisma.importJob.findUnique({ where: { id } });
    if (!job) throw new HttpError(404, 'Importação não encontrada');
    return { import: job };
  });
}
