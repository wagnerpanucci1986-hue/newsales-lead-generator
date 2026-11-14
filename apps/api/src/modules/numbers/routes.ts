import { NumberStatus, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import { qrCacheKey } from '../../lib/events.js';
import { prisma } from '../../lib/prisma.js';
import { sessionQueue } from '../../lib/queues.js';
import { redis } from '../../lib/redis.js';
import { localDay } from '../../lib/time.js';
import { accessibleNumberIds, authenticate, HttpError, requireRole } from '../auth/guard.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'cor deve estar no formato #rrggbb');
const createSchema = z.object({
  nickname: z.string().trim().min(1).max(40),
  color: color.default('#22c55e'),
  dailyLimit: z.number().int().min(1).max(5000).default(200),
  warmupEnabled: z.boolean().default(true),
});
const updateSchema = createSchema.partial().extend({ campaignEnabled: z.boolean().optional() });
const idParams = z.object({ id: z.string().min(1) });

const managers = [authenticate, requireRole(Role.ADMIN, Role.MANAGER)];

export async function numberRoutes(app: FastifyInstance) {
  // Lista os números visíveis ao usuário, com contadores do espelhamento.
  app.get('/', { preHandler: authenticate }, async (req) => {
    const ids = await accessibleNumberIds(req.user);
    const numbers = await prisma.waNumber.findMany({
      where: { deletedAt: null, ...(ids ? { id: { in: ids } } : {}) },
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { conversations: true, messages: true } },
        dailyStats: { where: { date: localDay() } },
      },
    });
    return {
      max: env.MAX_NUMBERS,
      numbers: numbers.map(({ _count, dailyStats, ...n }) => ({
        ...n,
        conversations: _count.conversations,
        messages: _count.messages,
        today: dailyStats[0] ?? null,
      })),
    };
  });

  app.post('/', { preHandler: managers }, async (req, reply) => {
    const data = createSchema.parse(req.body);
    // Trava consultiva: duas criações simultâneas não passam juntas pelo limite.
    const number = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(71001)`;
      const count = await tx.waNumber.count({ where: { deletedAt: null } });
      if (count >= env.MAX_NUMBERS) {
        throw new HttpError(409, `Limite de ${env.MAX_NUMBERS} números atingido. Remova um número para cadastrar outro.`);
      }
      return tx.waNumber.create({ data });
    });
    await audit({ userId: req.user.id, action: 'number.create', entity: 'WaNumber', entityId: number.id, meta: data, ip: req.ip });
    return reply.code(201).send({ number });
  });

  app.patch('/:id', { preHandler: managers }, async (req) => {
    const { id } = idParams.parse(req.params);
    const data = updateSchema.parse(req.body);
    await findNumber(id);
    const number = await prisma.waNumber.update({ where: { id }, data });
    await audit({ userId: req.user.id, action: 'number.update', entity: 'WaNumber', entityId: id, meta: data, ip: req.ip });
    return { number };
  });

  // Conectar: o worker abre a sessão; o QR chega pelo Socket.IO (evento number.qr).
  app.post('/:id/connect', { preHandler: managers }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const number = await findNumber(id);
    if (number.status === NumberStatus.BANNED) {
      // Permitido, mas registrado: o operador pode querer testar se a restrição caiu.
      await prisma.waNumber.update({ where: { id }, data: { status: NumberStatus.DISCONNECTED } });
    }
    await sessionQueue.add('connect', { action: 'connect', numberId: id });
    await audit({ userId: req.user.id, action: 'number.connect', entity: 'WaNumber', entityId: id, ip: req.ip });
    return reply.code(202).send({ ok: true });
  });

  app.post('/:id/disconnect', { preHandler: managers }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await findNumber(id);
    await sessionQueue.add('disconnect', { action: 'disconnect', numberId: id });
    await audit({ userId: req.user.id, action: 'number.disconnect', entity: 'WaNumber', entityId: id, ip: req.ip });
    return reply.code(202).send({ ok: true });
  });

  // Sair: desvincula o aparelho no WhatsApp e apaga as credenciais.
  app.post('/:id/logout', { preHandler: managers }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await findNumber(id);
    await sessionQueue.add('logout', { action: 'logout', numberId: id });
    await audit({ userId: req.user.id, action: 'number.logout', entity: 'WaNumber', entityId: id, ip: req.ip });
    return reply.code(202).send({ ok: true });
  });

  // Remoção lógica: o histórico de conversas fica; a vaga no limite de 10 é liberada.
  app.delete('/:id', { preHandler: managers }, async (req) => {
    const { id } = idParams.parse(req.params);
    await findNumber(id);
    await prisma.waNumber.update({ where: { id }, data: { deletedAt: new Date(), autoConnect: false, status: NumberStatus.DISCONNECTED } });
    await sessionQueue.add('remove', { action: 'remove', numberId: id });
    await audit({ userId: req.user.id, action: 'number.delete', entity: 'WaNumber', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // QR atual (para quem abriu a tela depois do evento em tempo real).
  app.get('/:id/qr', { preHandler: managers }, async (req) => {
    const { id } = idParams.parse(req.params);
    await findNumber(id);
    const cached = await redis.get(qrCacheKey(id));
    return { qr: cached ? JSON.parse(cached) : null };
  });
}

async function findNumber(id: string) {
  const number = await prisma.waNumber.findFirst({ where: { id, deletedAt: null } });
  if (!number) throw new HttpError(404, 'Número não encontrado');
  return number;
}
