import { AutomationAction, AutomationTrigger, KeywordMatch, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { prisma } from '../../lib/prisma.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const body = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    priority: z.number().int().min(0).max(1000).default(0),
    trigger: z.enum(AutomationTrigger),
    matchType: z.enum(KeywordMatch).default(KeywordMatch.CONTAINS),
    keywords: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    numberId: z.string().nullish(),
    action: z.enum(AutomationAction).default(AutomationAction.REPLY),
    responseText: z.string().trim().max(2000).nullish(),
    cooldownMinutes: z.number().int().min(1).max(10080).default(60),
  })
  .refine((r) => r.trigger !== AutomationTrigger.KEYWORD || r.keywords.length > 0, { message: 'informe ao menos uma palavra-chave', path: ['keywords'] })
  .refine((r) => r.action === AutomationAction.HANDOFF || Boolean(r.responseText), { message: 'escreva a resposta automática', path: ['responseText'] });

const idParams = z.object({ id: z.string() });

/** Regras de resposta automática (palavra-chave e fora do horário). */
export async function automationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  app.get('/', async () => ({
    rules: await prisma.automationRule.findMany({ orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], include: { number: { select: { id: true, nickname: true } } } }),
  }));

  app.post('/', async (req, reply) => {
    const data = body.parse(req.body);
    const rule = await prisma.automationRule.create({ data: { ...data, numberId: data.numberId || null, responseText: data.responseText || null } });
    await audit({ userId: req.user.id, action: 'automation.create', entity: 'AutomationRule', entityId: rule.id, meta: { name: rule.name }, ip: req.ip });
    return reply.code(201).send({ rule });
  });

  app.put('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const data = body.parse(req.body);
    if (!(await prisma.automationRule.findUnique({ where: { id } }))) throw new HttpError(404, 'Regra não encontrada');
    const rule = await prisma.automationRule.update({ where: { id }, data: { ...data, numberId: data.numberId || null, responseText: data.responseText || null } });
    await audit({ userId: req.user.id, action: 'automation.update', entity: 'AutomationRule', entityId: id, meta: { name: rule.name, enabled: rule.enabled }, ip: req.ip });
    return { rule };
  });

  app.patch('/:id/enabled', async (req) => {
    const { id } = idParams.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const rule = await prisma.automationRule.update({ where: { id }, data: { enabled } }).catch(() => {
      throw new HttpError(404, 'Regra não encontrada');
    });
    await audit({ userId: req.user.id, action: 'automation.update', entity: 'AutomationRule', entityId: id, meta: { enabled }, ip: req.ip });
    return { rule };
  });

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    await prisma.automationRule.deleteMany({ where: { id } });
    await audit({ userId: req.user.id, action: 'automation.delete', entity: 'AutomationRule', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
