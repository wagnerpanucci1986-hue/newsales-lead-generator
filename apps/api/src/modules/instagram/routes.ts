import { ImportStatus, Prisma, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { parseUsernames } from '../../instagram/extract.js';
import { discoverAccount, getConnection, GraphError, removeConnection, saveConnection } from '../../instagram/graph.js';
import { lookupProfiles, MAX_LOOKUP } from '../../instagram/lookup.js';
import { INSTAGRAM_CONSENT_SOURCE } from '../../instagram/to-contacts.js';
import { audit } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { contactsQueue } from '../../lib/queues.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';
import { destinationSchema, resolveDestination } from '../prospect-destination.js';

const username = z.string().regex(/^[a-z0-9._]{1,30}$/);

/** Captação pelo Instagram (Business Discovery da API oficial da Meta): Admin e Gestor. */
export async function instagramRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  app.get('/connection', async () => ({ connection: await getConnection(), graphVersion: env.META_GRAPH_VERSION, maxLookup: MAX_LOOKUP }));

  // Conectar: só administrador. O token é conferido na Meta e guardado cifrado.
  app.put('/connection', { preHandler: requireRole(Role.ADMIN) }, async (req) => {
    const b = z.object({ token: z.string().trim().min(20).max(1000), username: z.string().trim().max(31).optional() }).parse(req.body);
    try {
      const conn = await discoverAccount(b.token, b.username || undefined);
      await saveConnection(b.token, conn);
      await audit({ userId: req.user.id, action: 'instagram.connect', entity: 'Setting', entityId: 'instagram', meta: { igUsername: conn.igUsername, pageName: conn.pageName }, ip: req.ip });
      return { connection: conn };
    } catch (err) {
      if (err instanceof GraphError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  app.delete('/connection', { preHandler: requireRole(Role.ADMIN) }, async (req) => {
    await removeConnection();
    await audit({ userId: req.user.id, action: 'instagram.disconnect', entity: 'Setting', entityId: 'instagram', ip: req.ip });
    return { ok: true };
  });

  // Pesquisa até MAX_LOOKUP perfis por vez (consulta a Meta só os que não estão no cache).
  app.post('/lookup', async (req) => {
    const b = z.object({ input: z.string().max(20_000), force: z.boolean().default(false) }).parse(req.body);
    const { usernames, invalid } = parseUsernames(b.input);
    if (!usernames.length) throw new HttpError(400, 'Digite ao menos um @ de perfil.');
    if (usernames.length > MAX_LOOKUP) throw new HttpError(400, `São ${usernames.length} perfis. Pesquise até ${MAX_LOOKUP} por vez.`);
    if (!(await getConnection())) throw new HttpError(409, 'O Instagram ainda não está conectado. Um administrador conecta em Configurações → Instagram.');
    const result = await lookupProfiles(usernames, { force: b.force });
    await audit({ userId: req.user.id, action: 'instagram.lookup', entity: 'InstagramProfile', meta: { count: usernames.length, pending: result.pending.length }, ip: req.ip });
    return { ...result, invalid };
  });

  // Histórico de perfis já pesquisados.
  app.get('/profiles', async (req) => {
    const q = z
      .object({
        q: z.string().trim().max(100).optional(),
        withPhone: z.enum(['true', 'false']).optional(),
        hideKnown: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    const and: Prisma.InstagramProfileWhereInput[] = [{ error: null }];
    if (q.q) and.push({ OR: [{ username: { contains: q.q.toLowerCase().replace(/^@/, '') } }, { name: { contains: q.q, mode: 'insensitive' } }, { biography: { contains: q.q, mode: 'insensitive' } }] });
    if (q.withPhone === 'true') and.push({ NOT: { phones: { isEmpty: true } } });
    if (q.hideKnown === 'true') {
      // Esconde quem já tem o telefone em Contatos ou na lista de bloqueio.
      const known = await prisma.$queryRaw<{ username: string }[]>`
        SELECT p."username" FROM "InstagramProfile" p
        WHERE EXISTS (SELECT 1 FROM "Contact" c WHERE c."phone" = ANY(p."phones"))
           OR EXISTS (SELECT 1 FROM "BlacklistEntry" b WHERE b."phone" = ANY(p."phones"))`;
      if (known.length) and.push({ username: { notIn: known.map((k) => k.username) } });
    }
    const where = { AND: and };
    const [total, profiles] = await Promise.all([
      prisma.instagramProfile.count({ where }),
      prisma.instagramProfile.findMany({ where, orderBy: { fetchedAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { total, profiles };
  });

  app.post('/import', async (req, reply) => {
    const b = z.object({ usernames: z.array(username).min(1).max(1000), ...destinationSchema }).parse(req.body);
    const { tagIds, listId } = await resolveDestination(b);
    const job = await prisma.importJob.create({
      data: {
        fileName: `Instagram (${b.usernames.length.toLocaleString('pt-BR')} perfis)`,
        storageKey: 'instagram',
        status: ImportStatus.PROCESSING,
        totalRows: b.usernames.length,
        columnMapping: { instagram: { usernames: b.usernames } },
        listId,
        tagIds,
        consentSource: INSTAGRAM_CONSENT_SOURCE,
        createdById: req.user.id,
      },
    });
    await contactsQueue.add('instagram-contacts', { kind: 'instagram-contacts', importId: job.id });
    await audit({ userId: req.user.id, action: 'instagram.import_contacts', entity: 'ImportJob', entityId: job.id, meta: { count: b.usernames.length }, ip: req.ip });
    return reply.code(202).send({ import: job });
  });
}
