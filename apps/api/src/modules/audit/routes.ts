import { Role, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../auth/guard.js';

const query = z.object({
  userId: z.string().optional(),
  action: z.string().trim().max(60).optional(), // prefixo: "campaign." traz todas as ações de campanha
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Log de auditoria: quem fez o quê e quando. Só administradores. */
export async function auditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN));

  app.get('/', async (req) => {
    const q = query.parse(req.query);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.userId === 'system' ? { userId: null } : q.userId ? { userId: q.userId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
    };
    const [total, entries] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, include: { user: { select: { name: true, email: true } } } }),
    ]);
    return { total, page: q.page, limit: q.limit, entries };
  });
}
