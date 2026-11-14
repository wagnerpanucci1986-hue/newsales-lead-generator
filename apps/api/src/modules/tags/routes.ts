import { Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isUniqueViolation, prisma } from '../../lib/prisma.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const body = z.object({
  name: z.string().trim().min(1).max(30),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
});
const managers = requireRole(Role.ADMIN, Role.MANAGER);

/** Etiquetas, compartilhadas entre conversas e contatos. */
export async function tagRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async () => ({ tags: await prisma.tag.findMany({ orderBy: { name: 'asc' } }) }));

  app.post('/', { preHandler: managers }, async (req, reply) => {
    try {
      return reply.code(201).send({ tag: await prisma.tag.create({ data: body.parse(req.body) }) });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Já existe uma etiqueta com este nome');
      throw err;
    }
  });

  app.delete('/:id', { preHandler: managers }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.tag.deleteMany({ where: { id } });
    return { ok: true };
  });
}
