import { CnpjImportStatus, ImportStatus, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CNPJ_CONSENT_SOURCE } from '../../cnpj/to-contacts.js';
import { cnpjFiltersSchema, searchCnpj } from '../../cnpj/search.js';
import { audit } from '../../lib/audit.js';
import { isUniqueViolation, prisma } from '../../lib/prisma.js';
import { cnpjQueue, contactsQueue } from '../../lib/queues.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'] as const;
const MAX_IMPORT = 5000;

// Busca sem acento e sem caixa: "construcao" encontra "Construção".
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let cnaeCache: { code: string; description: string; folded: string }[] | null = null;
async function cnaes() {
  if (!cnaeCache?.length) {
    const rows = await prisma.cnpjCnae.findMany({ orderBy: { code: 'asc' } });
    cnaeCache = rows.map((r) => ({ ...r, folded: fold(`${r.code} ${r.description}`) }));
  }
  return cnaeCache;
}

const importBody = z.object({
  filters: cnpjFiltersSchema,
  cnpjs: z.array(z.string().regex(/^[0-9A-Z]{14}$/)).max(MAX_IMPORT).optional(),
  limit: z.number().int().min(1).max(MAX_IMPORT).default(500),
  includeFixed: z.boolean().default(false),
  tagIds: z.array(z.string()).max(20).default([]),
  newTags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  listId: z.string().nullish(),
  newListName: z.string().trim().min(1).max(80).nullish(),
});

/** Captação pela base pública de CNPJ: só Admin e Gestor. */
export async function cnpjRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  // Situação da base: UFs carregadas, totais e atualizações recentes.
  app.get('/status', async () => {
    const [byUf, imports] = await Promise.all([
      prisma.$queryRaw<{ uf: string; total: bigint; mobile: bigint }[]>`
        SELECT "uf", count(*) AS total, count(*) FILTER (WHERE "hasMobile") AS mobile FROM "CnpjEstablishment" GROUP BY "uf" ORDER BY "uf"`,
      prisma.cnpjImport.findMany({ orderBy: { startedAt: 'desc' }, take: 5 }),
    ]);
    return {
      ufs: byUf.map((r) => ({ uf: r.uf, total: Number(r.total), mobile: Number(r.mobile) })),
      imports,
      allUfs: UFS,
    };
  });

  app.post('/refresh', async (req, reply) => {
    const { ufs } = z.object({ ufs: z.array(z.enum(UFS)).min(1).max(27) }).parse(req.body);
    if (await prisma.cnpjImport.findFirst({ where: { status: CnpjImportStatus.RUNNING } })) {
      throw new HttpError(409, 'Já existe uma atualização da base em andamento.');
    }
    const job = await prisma.cnpjImport.create({ data: { ufs, createdById: req.user.id, progress: 'Na fila' } });
    await cnpjQueue.add('refresh', { importId: job.id }, { jobId: `cnpj-${job.id}` });
    await audit({ userId: req.user.id, action: 'cnpj.refresh', entity: 'CnpjImport', entityId: job.id, meta: { ufs }, ip: req.ip });
    return reply.code(202).send({ import: job });
  });

  app.get('/cnaes', async (req) => {
    const { q } = z.object({ q: z.string().trim().max(80).default('') }).parse(req.query);
    const terms = fold(q).split(/\s+/).filter(Boolean);
    const digits = q.replace(/\D/g, '');
    const list = (await cnaes()).filter((c) => (digits.length >= 2 && c.code.startsWith(digits)) || (terms.length > 0 && terms.every((t) => c.folded.includes(t))));
    return { cnaes: list.slice(0, 30).map(({ code, description }) => ({ code, description })) };
  });

  app.get('/municipios', async (req) => {
    const { uf, q } = z.object({ uf: z.enum(UFS), q: z.string().trim().max(60).default('') }).parse(req.query);
    const rows = await prisma.$queryRaw<{ code: string; name: string | null; total: bigint }[]>`
      SELECT "municipioCodigo" AS code, max("municipio") AS name, count(*) AS total FROM "CnpjEstablishment"
      WHERE "uf" = ${uf} GROUP BY "municipioCodigo" ORDER BY count(*) DESC`;
    const term = fold(q);
    return {
      municipios: rows
        .filter((r) => !term || fold(r.name ?? '').includes(term))
        .slice(0, 30)
        .map((r) => ({ code: r.code, name: r.name ?? r.code, total: Number(r.total) })),
    };
  });

  app.get('/naturezas', async () => ({ naturezas: await prisma.cnpjNatureza.findMany({ orderBy: { description: 'asc' } }) }));

  app.post('/search', async (req) => {
    const body = z.object({ filters: cnpjFiltersSchema, page: z.number().int().min(1).max(400).default(1), limit: z.number().int().min(1).max(100).default(25) }).parse(req.body);
    const result = await searchCnpj(body.filters, body.page, body.limit);
    return { ...result, page: body.page, limit: body.limit };
  });

  // Leva as empresas escolhidas para Contatos, em segundo plano (acompanha por /api/imports/:id).
  app.post('/import', async (req, reply) => {
    const b = importBody.parse(req.body);
    const tagIds = [...b.tagIds];
    for (const name of b.newTags) {
      const tag = await prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
      tagIds.push(tag.id);
    }
    let listId = b.listId ?? null;
    if (b.newListName) {
      try {
        listId = (await prisma.contactList.create({ data: { name: b.newListName } })).id;
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma lista com este nome');
        throw err;
      }
    }
    const count = b.cnpjs?.length ?? b.limit;
    const job = await prisma.importJob.create({
      data: {
        fileName: `Base de CNPJ — ${b.filters.uf} (${count.toLocaleString('pt-BR')} empresas)`,
        storageKey: 'cnpj',
        status: ImportStatus.PROCESSING,
        totalRows: count,
        columnMapping: { cnpj: { filters: b.filters, cnpjs: b.cnpjs, limit: count, includeFixed: b.includeFixed } },
        listId,
        tagIds: [...new Set(tagIds)],
        consentSource: CNPJ_CONSENT_SOURCE,
        createdById: req.user.id,
      },
    });
    await contactsQueue.add('cnpj-contacts', { kind: 'cnpj-contacts', importId: job.id });
    await audit({ userId: req.user.id, action: 'cnpj.import_contacts', entity: 'ImportJob', entityId: job.id, meta: { filters: b.filters, count, includeFixed: b.includeFixed }, ip: req.ip });
    return reply.code(202).send({ import: job });
  });
}
