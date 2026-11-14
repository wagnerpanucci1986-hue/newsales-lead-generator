import { Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isUniqueViolation, prisma } from '../../lib/prisma.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const body = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).nullish() });
const idParams = z.object({ id: z.string() });

/** Listas estáticas de contatos, usadas como público das campanhas. */
export async function listRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  app.get('/', async () => {
    const lists = await prisma.contactList.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { members: true } } } });
    return { lists: lists.map(({ _count, ...l }) => ({ ...l, members: _count.members })) };
  });

  app.post('/', async (req, reply) => {
    try {
      return reply.code(201).send({ list: { ...(await prisma.contactList.create({ data: body.parse(req.body) })), members: 0 } });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma lista com este nome');
      throw err;
    }
  });

  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    try {
      return { list: await prisma.contactList.update({ where: { id }, data: body.partial().parse(req.body) }) };
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma lista com este nome');
      throw err;
    }
  });

  // Apaga a lista; os contatos continuam cadastrados.
  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const running = await prisma.campaignList.count({ where: { listId: id, campaign: { status: { in: ['SCHEDULED', 'DRAFT'] } } } });
    if (running) throw new HttpError(409, 'Esta lista está em uma campanha em rascunho ou agendada. Remova-a da campanha antes.');
    await prisma.contactList.deleteMany({ where: { id } });
    return { ok: true };
  });
}
