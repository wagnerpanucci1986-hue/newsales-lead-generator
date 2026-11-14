import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../auth/guard.js';

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Só nome e perfil: usado nos seletores de responsável. A gestão de usuários entra na fase 5.
  app.get('/assignable', async () => ({
    users: await prisma.user.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } }),
  }));
}
