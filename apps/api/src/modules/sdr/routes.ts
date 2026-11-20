import { AiStatus, LeadStage, LeadTemperature, Prisma, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { publishEvent } from '../../lib/events.js';
import { prisma } from '../../lib/prisma.js';
import { randomToken } from '../../lib/crypto.js';
import { redis } from '../../lib/redis.js';
import { getSetting } from '../../lib/settings.js';
import { authUrl, disconnectGoogle, finishAuth, googleStatus, saveClient } from '../../sdr/google.js';
import { hasApiKey } from '../../sdr/model.js';
import { simulate } from '../../sdr/simulate.js';
import { leadSheet } from '../../sdr/tools.js';
import { generateVariations } from '../../sdr/variations.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const DAY = 86_400_000;

function apiError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  throw new HttpError(502, err instanceof Error ? err.message : 'Falha ao falar com a IA');
}

/** IA do SDR: situação, leads, teste, variações e controle por conversa. */
export async function sdrRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Controle por conversa: qualquer atendente com acesso à conversa pode pausar ou retomar.
  app.get('/conversations/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const conv = await prisma.conversation.findUnique({ where: { id }, include: { sdrLead: true, contact: true } });
    if (!conv) throw new HttpError(404, 'Conversa não encontrada');
    const runs = await prisma.sdrRun.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'desc' }, take: 10 });
    return { aiStatus: conv.aiStatus, paused: Boolean(conv.automationPausedAt), lead: conv.sdrLead, sheet: conv.sdrLead ? leadSheet(conv.sdrLead, conv.contact) : null, runs };
  });

  app.post('/conversations/:id/ai', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { action } = z.object({ action: z.enum(['activate', 'pause', 'stop']) }).parse(req.body);
    const conv = await prisma.conversation.findUnique({ where: { id }, select: { id: true, numberId: true, isGroup: true } });
    if (!conv) throw new HttpError(404, 'Conversa não encontrada');
    if (conv.isGroup) throw new HttpError(400, 'A IA não atende grupos.');
    if (action === 'activate') {
      // Ligar ou retomar: a IA volta a responder e o humano sai de cena.
      await prisma.conversation.update({ where: { id }, data: { aiStatus: AiStatus.ACTIVE, automationPausedAt: null } });
      await prisma.sdrLead.upsert({ where: { conversationId: id }, create: { conversationId: id }, update: {} });
    } else if (action === 'pause') {
      await prisma.conversation.update({ where: { id }, data: { automationPausedAt: new Date() } });
    } else {
      await prisma.conversation.update({ where: { id }, data: { aiStatus: AiStatus.OFF } });
      await prisma.sdrLead.updateMany({ where: { conversationId: id }, data: { nextFollowUpAt: null } });
    }
    await prisma.conversationEvent.create({ data: { conversationId: id, userId: req.user.id, type: `sdr_${action}` } });
    await audit({ userId: req.user.id, action: `sdr.${action}`, entity: 'Conversation', entityId: id, ip: req.ip });
    await publishEvent({ type: 'conversation.updated', numberId: conv.numberId, payload: { conversationId: id } });
    return { ok: true };
  });

  // O resto é gestão: Admin e Gestor.
  app.register(async (mgr) => {
    mgr.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

    mgr.get('/status', async () => {
      const cfg = await getSetting('sdr');
      const since = new Date(Date.now() - 7 * DAY);
      const [byTemp, byStage, upcoming, runs, google] = await Promise.all([
        prisma.sdrLead.groupBy({ by: ['temperature'], _count: true }),
        prisma.sdrLead.groupBy({ by: ['stage'], _count: true }),
        prisma.sdrLead.count({ where: { stage: LeadStage.AGENDADO, meetingStart: { gt: new Date() } } }),
        prisma.sdrRun.aggregate({ where: { createdAt: { gte: since } }, _count: true, _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true } }),
        googleStatus(),
      ]);
      const errors = await prisma.sdrRun.count({ where: { createdAt: { gte: since }, status: 'error' } });
      return {
        enabled: cfg.enabled,
        hasApiKey: hasApiKey(),
        consultants: cfg.consultants.filter((c) => c.active).length,
        google,
        temperature: Object.fromEntries(byTemp.map((r) => [r.temperature ?? 'SEM', r._count])),
        stage: Object.fromEntries(byStage.map((r) => [r.stage, r._count])),
        upcomingMeetings: upcoming,
        week: { runs: runs._count, errors, inputTokens: runs._sum.inputTokens ?? 0, outputTokens: runs._sum.outputTokens ?? 0, cacheReadTokens: runs._sum.cacheReadTokens ?? 0 },
      };
    });

    mgr.get('/leads', async (req) => {
      const q = z
        .object({
          temperature: z.enum(LeadTemperature).optional(),
          stage: z.enum(LeadStage).optional(),
          q: z.string().trim().max(100).optional(),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(req.query);
      const where: Prisma.SdrLeadWhereInput = {
        ...(q.temperature ? { temperature: q.temperature } : {}),
        ...(q.stage ? { stage: q.stage } : {}),
        ...(q.q
          ? { OR: [{ produto: { contains: q.q, mode: 'insensitive' } }, { conversation: { contact: { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { company: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q.replace(/\D/g, '') || q.q } }] } } }] }
          : {}),
      };
      const [total, leads] = await Promise.all([
        prisma.sdrLead.count({ where }),
        prisma.sdrLead.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: (q.page - 1) * q.limit,
          take: q.limit,
          include: { conversation: { select: { id: true, aiStatus: true, automationPausedAt: true, lastMessageAt: true, lastMessagePreview: true, contact: { select: { name: true, company: true, phone: true, pushName: true } } } } },
        }),
      ]);
      return { total, leads };
    });

    // Conversa de teste: nada é enviado nem gravado.
    mgr.post('/simulate', async (req) => {
      const b = z
        .object({
          messages: z.array(z.object({ fromMe: z.boolean(), text: z.string().max(2000) })).min(1).max(40),
          contact: z.object({ name: z.string().max(80).optional(), company: z.string().max(120).optional(), customFields: z.record(z.string(), z.string().max(200)).optional() }).default({}),
          lead: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body);
      if (!hasApiKey()) throw new HttpError(409, 'Configure a chave da API da Anthropic (ANTHROPIC_API_KEY no .env) e reinicie o sistema.');
      try {
        return await simulate({ messages: b.messages, contact: b.contact, lead: b.lead as never });
      } catch (err) {
        apiError(err);
      }
    });

    mgr.post('/variations', async (req) => {
      const b = z.object({ body: z.string().trim().min(10).max(4096), count: z.number().int().min(2).max(10).default(6) }).parse(req.body);
      if (!hasApiKey()) throw new HttpError(409, 'Configure a chave da API da Anthropic (ANTHROPIC_API_KEY no .env) e reinicie o sistema.');
      try {
        const r = await generateVariations(b.body, b.count);
        await audit({ userId: req.user.id, action: 'sdr.variations', meta: { count: r.variations.length }, ip: req.ip });
        return r;
      } catch (err) {
        apiError(err);
      }
    });
  });
}

/** Google Agenda: conexão OAuth da conta que marca as reuniões. */
export async function googleRoutes(app: FastifyInstance) {
  // Retorno do Google: o navegador chega aqui sem o token do painel; quem prova é o `state`.
  app.get('/callback', async (req, reply) => {
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    const userId = q.state ? await redis.getdel(`google:oauth:${q.state}`) : null;
    const back = (status: string, msg?: string) => reply.redirect(`/sdr?google=${status}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}`);
    if (!userId) return back('erro', 'A autorização expirou. Clique em Conectar de novo.');
    if (q.error || !q.code) return back('erro', q.error === 'access_denied' ? 'Você não autorizou o acesso.' : (q.error ?? 'Sem código de autorização'));
    try {
      const email = await finishAuth(q.code);
      await audit({ userId, action: 'google.connect', meta: { email } });
      return back('ok');
    } catch (err) {
      return back('erro', err instanceof Error ? err.message : 'Falha ao conectar');
    }
  });

  app.register(async (adm) => {
    adm.addHook('preHandler', authenticate);
    adm.addHook('preHandler', requireRole(Role.ADMIN));

    adm.get('/status', async () => googleStatus());

    adm.put('/client', async (req) => {
      const b = z.object({ clientId: z.string().trim().min(20).max(300), clientSecret: z.string().trim().min(10).max(300) }).parse(req.body);
      await saveClient(b.clientId, b.clientSecret);
      await audit({ userId: req.user.id, action: 'google.client', ip: req.ip });
      return googleStatus();
    });

    adm.get('/auth-url', async (req) => {
      const state = randomToken(24);
      await redis.set(`google:oauth:${state}`, req.user.id, 'EX', 600);
      try {
        return { url: await authUrl(state) };
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'Falha');
      }
    });

    adm.delete('/', async (req) => {
      await disconnectGoogle();
      await audit({ userId: req.user.id, action: 'google.disconnect', ip: req.ip });
      return { ok: true };
    });
  });
}
