import { BlacklistSource, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { normalizePhone } from '../../lib/phone.js';
import { prisma } from '../../lib/prisma.js';
import { authenticate, requireRole } from '../auth/guard.js';

const listQuery = z.object({ q: z.string().trim().max(30).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });
const addBody = z.object({
  // Um telefone por linha (ou separados por vírgula/ponto e vírgula).
  phones: z.string().min(1).max(200_000),
  reason: z.string().trim().max(200).nullish(),
});

/** Lista de bloqueio global: ninguém aqui recebe campanha nem resposta automática. */
export async function blacklistRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  app.get('/', async (req) => {
    const q = listQuery.parse(req.query);
    const digits = q.q?.replace(/\D/g, '');
    const where = digits ? { phone: { contains: digits } } : {};
    const [total, entries] = await Promise.all([
      prisma.blacklistEntry.count({ where }),
      prisma.blacklistEntry.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { total, page: q.page, limit: q.limit, entries };
  });

  app.post('/', async (req) => {
    const b = addBody.parse(req.body);
    const valid = new Set<string>();
    const invalid: string[] = [];
    for (const piece of b.phones.split(/[\n,;]+/)) {
      if (!piece.trim()) continue;
      const r = normalizePhone(piece);
      if (r.ok) valid.add(r.phone);
      else invalid.push(piece.trim());
    }
    const phones = [...valid];
    const { count } = await prisma.blacklistEntry.createMany({
      data: phones.map((phone) => ({ phone, source: BlacklistSource.MANUAL, reason: b.reason || null })),
      skipDuplicates: true,
    });
    // Tira da fila o que ainda não foi enviado para estes telefones.
    await prisma.campaignRecipient.updateMany({
      where: { status: 'QUEUED', contact: { phone: { in: phones } } },
      data: { status: 'SKIPPED', skipReason: 'blacklist' },
    });
    await audit({ userId: req.user.id, action: 'blacklist.add', meta: { added: count, invalid: invalid.length }, ip: req.ip });
    return { added: count, alreadyListed: phones.length - count, invalid: invalid.slice(0, 50) };
  });

  // Remover reverte também o opt-out do contato: use só a pedido da pessoa.
  app.delete('/:phone', async (req) => {
    const { phone } = z.object({ phone: z.string().regex(/^\d{8,15}$/) }).parse(req.params);
    await prisma.blacklistEntry.deleteMany({ where: { phone } });
    await prisma.contact.updateMany({ where: { phone }, data: { optedOutAt: null } });
    await audit({ userId: req.user.id, action: 'blacklist.remove', meta: { phone }, ip: req.ip });
    return { ok: true };
  });
}
