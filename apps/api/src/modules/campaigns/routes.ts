import { CampaignStatus, LegalBasis, MediaStatus, RecipientStatus, Role, type Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { audienceFilterSchema, campaignStats, previewAudience } from '../../campaigns/audience.js';
import { legalBasisProblem } from '../../campaigns/legal.js';
import { getSetting } from '../../lib/settings.js';
import { audit } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { publishEvent } from '../../lib/events.js';
import { signedMediaPath } from '../../lib/media-url.js';
import { prisma } from '../../lib/prisma.js';
import { campaignQueue } from '../../lib/queues.js';
import { storage } from '../../lib/storage/index.js';
import { BUILTIN_VARIABLES, normalizeVariableKey, renderTemplate, usedVariables } from '../../lib/template.js';
import { authenticate, HttpError, requireRole } from '../auth/guard.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use o formato HH:MM');
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'fuso horário inválido');

const campaignBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    body: z.string().max(4096).default(''),
    listIds: z.array(z.string()).max(50).default([]),
    numberIds: z.array(z.string()).max(10).default([]),
    audienceFilter: audienceFilterSchema.default({ tagIds: [], onlyWaValid: false }),
    scheduledAt: z.coerce.date().nullish(),
    timezone: timezone.default('America/Sao_Paulo'),
    sendDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
    windowStart: hhmm.default('09:00'),
    windowEnd: hhmm.default('18:00'),
    // Pisos de segurança: abaixo disso o risco de banimento é alto demais para ser uma opção.
    minDelayS: z.number().int().min(5).max(3600).default(15),
    maxDelayS: z.number().int().min(5).max(7200).default(60),
    longPauseEvery: z.number().int().min(0).max(1000).default(20),
    longPauseMinS: z.number().int().min(30).max(7200).default(300),
    longPauseMaxS: z.number().int().min(30).max(14400).default(900),
    simulateTyping: z.boolean().default(true),
    consentConfirmed: z.boolean().default(false),
    legalBasis: z.enum(LegalBasis).nullish(),
    sdrEnabled: z.boolean().default(false),
    variants: z.array(z.string().trim().min(1).max(4096)).max(20).default([]),
  })
  .refine((c) => c.maxDelayS >= c.minDelayS, { message: 'o intervalo máximo deve ser maior ou igual ao mínimo', path: ['maxDelayS'] })
  .refine((c) => c.longPauseMaxS >= c.longPauseMinS, { message: 'a pausa longa máxima deve ser maior ou igual à mínima', path: ['longPauseMaxS'] });

const idParams = z.object({ id: z.string() });
const recipientsQuery = z.object({
  status: z.enum(RecipientStatus).optional(),
  only: z.enum(['replied', 'optOut']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const include = {
  media: true,
  numbers: { include: { number: { select: { id: true, nickname: true, color: true, status: true } } } },
  lists: { include: { list: { select: { id: true, name: true } } } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.CampaignInclude;
type Row = Prisma.CampaignGetPayload<{ include: typeof include }>;

function dto(c: Row, stats: Awaited<ReturnType<typeof campaignStats>>) {
  const { media, numbers, lists, ...rest } = c;
  return {
    ...rest,
    numbers: numbers.map((n) => n.number),
    lists: lists.map((l) => l.list),
    media: media ? { id: media.id, fileName: media.fileName, mimeType: media.mimeType, size: media.size, url: signedMediaPath(media.id) } : null,
    stats: stats.get(c.id)!,
  };
}

async function load(id: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id }, include });
  if (!campaign) throw new HttpError(404, 'Campanha não encontrada');
  return campaign;
}

function relations(body: z.infer<typeof campaignBody>) {
  return {
    name: body.name,
    body: body.body,
    audienceFilter: body.audienceFilter,
    scheduledAt: body.scheduledAt ?? null,
    timezone: body.timezone,
    sendDays: [...new Set(body.sendDays)].sort(),
    windowStart: body.windowStart,
    windowEnd: body.windowEnd,
    minDelayS: body.minDelayS,
    maxDelayS: body.maxDelayS,
    longPauseEvery: body.longPauseEvery,
    longPauseMinS: body.longPauseMinS,
    longPauseMaxS: body.longPauseMaxS,
    simulateTyping: body.simulateTyping,
    consentConfirmed: body.consentConfirmed,
    legalBasis: body.legalBasis ?? null,
    sdrEnabled: body.sdrEnabled,
    variants: body.variants,
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Evita que uma célula começando com = + - @ seja executada como fórmula no Excel.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Campanhas de disparo: só Admin e Gestor. */
export async function campaignRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole(Role.ADMIN, Role.MANAGER));

  app.get('/', async () => {
    const rows = await prisma.campaign.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include });
    const stats = await campaignStats(rows.map((r) => r.id));
    return { campaigns: rows.map((r) => dto(r, stats)) };
  });

  app.get('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const campaign = await load(id);
    const [stats, perNumber] = await Promise.all([
      campaignStats([id]),
      prisma.campaignRecipient.groupBy({ by: ['numberId', 'status'], where: { campaignId: id, numberId: { not: null } }, _count: true }),
    ]);
    // Envios por número, para ver o balanceamento do rodízio.
    const byNumber: Record<string, { sent: number; failed: number }> = {};
    for (const row of perNumber) {
      const entry = (byNumber[row.numberId!] ??= { sent: 0, failed: 0 });
      if (row.status === 'FAILED') entry.failed += row._count;
      else if (row.status === 'SENT' || row.status === 'DELIVERED' || row.status === 'READ') entry.sent += row._count;
    }
    return { campaign: dto(campaign, stats), byNumber };
  });

  app.post('/', async (req, reply) => {
    const body = campaignBody.parse(req.body);
    const campaign = await prisma.campaign.create({
      data: {
        ...relations(body),
        createdById: req.user.id,
        numbers: { create: body.numberIds.map((numberId) => ({ numberId })) },
        lists: { create: body.listIds.map((listId) => ({ listId })) },
      },
      include,
    });
    await audit({ userId: req.user.id, action: 'campaign.create', entity: 'Campaign', entityId: campaign.id, ip: req.ip });
    return reply.code(201).send({ campaign: dto(campaign, await campaignStats([campaign.id])) });
  });

  // Edição completa só em rascunho: depois de iniciada, o conteúdo já foi enviado a parte do público.
  app.put('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = campaignBody.parse(req.body);
    const current = await load(id);
    if (current.status !== CampaignStatus.DRAFT) throw new HttpError(409, 'Só campanhas em rascunho podem ser editadas');
    const campaign = await prisma.campaign.update({
      where: { id },
      data: {
        ...relations(body),
        numbers: { deleteMany: {}, create: body.numberIds.map((numberId) => ({ numberId })) },
        lists: { deleteMany: {}, create: body.listIds.map((listId) => ({ listId })) },
      },
      include,
    });
    return { campaign: dto(campaign, await campaignStats([id])) };
  });

  // Anexo da campanha (imagem, PDF, áudio ou vídeo). Enviar outro substitui o anterior.
  app.post('/:id/media', async (req) => {
    const { id } = idParams.parse(req.params);
    const current = await load(id);
    if (current.status !== CampaignStatus.DRAFT) throw new HttpError(409, 'Só campanhas em rascunho podem ser editadas');
    const file = req.isMultipart() ? await req.file() : undefined;
    if (!file) throw new HttpError(400, 'Envie um arquivo');
    const buffer = await file.toBuffer();
    if (!buffer.length) throw new HttpError(400, 'Arquivo vazio');
    const fileName = path.basename(file.filename || 'anexo').slice(0, 200);
    const storageKey = `campanhas/${id}/${randomUUID()}${path.extname(fileName).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 9)}`;
    const mimeType = file.mimetype || 'application/octet-stream';
    await storage.put(storageKey, buffer, mimeType);
    const media = await prisma.media.create({ data: { status: MediaStatus.STORED, storageKey, mimeType, fileName, size: buffer.length, sha256: sha256(buffer) } });
    await prisma.campaign.update({ where: { id }, data: { mediaId: media.id } });
    return { campaign: dto(await load(id), await campaignStats([id])) };
  });

  app.delete('/:id/media', async (req) => {
    const { id } = idParams.parse(req.params);
    const current = await load(id);
    if (current.status !== CampaignStatus.DRAFT) throw new HttpError(409, 'Só campanhas em rascunho podem ser editadas');
    await prisma.campaign.update({ where: { id }, data: { mediaId: null } });
    return { campaign: dto(await load(id), await campaignStats([id])) };
  });

  // Prévia: tamanho do público, quem será pulado, exemplos de mensagem e variáveis inexistentes.
  app.post('/preview', async (req) => {
    const body = z.object({ body: z.string().max(4096).default(''), listIds: z.array(z.string()).default([]), audienceFilter: audienceFilterSchema.default({ tagIds: [], onlyWaValid: false }) }).parse(req.body);
    const audience = await previewAudience(body.listIds, body.audienceFilter);
    const where = body.listIds.length || body.audienceFilter.tagIds.length
      ? { AND: [body.listIds.length ? { lists: { some: { listId: { in: body.listIds } } } } : {}, body.audienceFilter.tagIds.length ? { tags: { some: { tagId: { in: body.audienceFilter.tagIds } } } } : {}] }
      : null;
    const contacts = where ? await prisma.contact.findMany({ where, take: 3, orderBy: { id: 'asc' } }) : [];
    const customKeys = await prisma.$queryRaw<{ key: string }[]>`SELECT DISTINCT jsonb_object_keys("customFields") AS key FROM "Contact" WHERE "customFields" <> '{}'::jsonb LIMIT 200`;
    const known = new Set([...BUILTIN_VARIABLES, ...customKeys.map((k) => normalizeVariableKey(k.key))]);
    return {
      audience,
      samples: contacts.map((c) => ({ contact: c.name ?? c.phone, text: renderTemplate(body.body, c) })),
      unknownVariables: usedVariables(body.body).filter((v) => !known.has(v)),
    };
  });

  // Iniciar (agora ou na data agendada). Exige a confirmação de consentimento (LGPD).
  app.post('/:id/start', async (req) => {
    const { id } = idParams.parse(req.params);
    const c = await load(id);
    if (c.status !== CampaignStatus.DRAFT) throw new HttpError(409, 'Esta campanha já foi iniciada');
    const legal = legalBasisProblem(c, (await getSetting('optOut')).keywords);
    if (legal) throw new HttpError(400, legal);
    if (!c.body.trim() && !c.variants.length && !c.media) throw new HttpError(400, 'Escreva a mensagem ou adicione um anexo.');
    if (c.sdrEnabled && !(await getSetting('sdr')).enabled) throw new HttpError(400, 'A campanha usa a IA do SDR, mas ela está desligada. Ligue em SDR (IA) ou desmarque a opção na campanha.');
    if (!c.numbers.length) throw new HttpError(400, 'Escolha ao menos um número para enviar.');
    const filter = audienceFilterSchema.parse(c.audienceFilter ?? {});
    if (!c.lists.length && !filter.tagIds.length) throw new HttpError(400, 'Escolha ao menos uma lista ou etiqueta como público.');

    const scheduled = c.scheduledAt && c.scheduledAt > new Date();
    await prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.SCHEDULED, scheduledAt: scheduled ? c.scheduledAt : null } });
    if (!scheduled) await campaignQueue.add('start', { kind: 'start', campaignId: id }, { jobId: `start-${id}` });
    await audit({ userId: req.user.id, action: 'campaign.start', entity: 'Campaign', entityId: id, meta: { scheduledAt: scheduled ? c.scheduledAt : null, consentConfirmed: true, legalBasis: c.legalBasis }, ip: req.ip });
    await publishEvent({ type: 'campaign.updated', payload: { campaignId: id } });
    return { campaign: dto(await load(id), await campaignStats([id])) };
  });

  // Pausar, retomar e cancelar valem a partir do próximo envio: o que já está saindo termina.
  const transition = (action: 'pause' | 'resume' | 'cancel') => async (req: { params: unknown; user: { id: string }; ip: string }) => {
    const { id } = idParams.parse(req.params);
    const c = await load(id);
    const allowed: Record<typeof action, CampaignStatus[]> = {
      pause: [CampaignStatus.RUNNING, CampaignStatus.SCHEDULED],
      resume: [CampaignStatus.PAUSED],
      cancel: [CampaignStatus.RUNNING, CampaignStatus.SCHEDULED, CampaignStatus.PAUSED, CampaignStatus.DRAFT],
    };
    if (!allowed[action].includes(c.status)) throw new HttpError(409, 'Ação não permitida no estado atual da campanha');

    if (action === 'pause') {
      await prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.PAUSED } });
    } else if (action === 'resume') {
      // Se os destinatários ainda não foram montados (pausada antes de começar), volta para a fila de início.
      await prisma.campaign.update({ where: { id }, data: { status: c.startedAt ? CampaignStatus.RUNNING : CampaignStatus.SCHEDULED } });
    } else {
      await prisma.$transaction([
        prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.CANCELED, finishedAt: new Date() } }),
        prisma.campaignRecipient.updateMany({ where: { campaignId: id, status: RecipientStatus.QUEUED }, data: { status: RecipientStatus.SKIPPED, skipReason: 'campanha cancelada' } }),
      ]);
    }
    await audit({ userId: req.user.id, action: `campaign.${action}`, entity: 'Campaign', entityId: id, ip: req.ip });
    await publishEvent({ type: 'campaign.updated', payload: { campaignId: id } });
    return { campaign: dto(await load(id), await campaignStats([id])) };
  };
  app.post('/:id/pause', transition('pause'));
  app.post('/:id/resume', transition('resume'));
  app.post('/:id/cancel', transition('cancel'));

  app.delete('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const c = await load(id);
    if (c.status === CampaignStatus.RUNNING || c.status === CampaignStatus.SCHEDULED) throw new HttpError(409, 'Pause ou cancele a campanha antes de excluir');
    await prisma.campaign.delete({ where: { id } });
    await audit({ userId: req.user.id, action: 'campaign.delete', entity: 'Campaign', entityId: id, meta: { name: c.name }, ip: req.ip });
    return { ok: true };
  });

  const recipientWhere = (id: string, q: z.infer<typeof recipientsQuery>): Prisma.CampaignRecipientWhereInput => ({
    campaignId: id,
    ...(q.status ? { status: q.status } : {}),
    ...(q.only === 'replied' ? { repliedAt: { not: null } } : {}),
    ...(q.only === 'optOut' ? { optedOutAt: { not: null } } : {}),
  });
  const recipientInclude = { contact: { select: { name: true, phone: true } }, number: { select: { nickname: true } } } as const;

  app.get('/:id/recipients', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = recipientsQuery.parse(req.query);
    const where = recipientWhere(id, q);
    const [total, rows] = await Promise.all([
      prisma.campaignRecipient.count({ where }),
      prisma.campaignRecipient.findMany({ where, include: recipientInclude, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
    ]);
    return { total, page: q.page, limit: q.limit, recipients: rows };
  });

  app.get('/:id/export.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const c = await load(id);
    const rows = await prisma.campaignRecipient.findMany({ where: { campaignId: id }, include: recipientInclude, orderBy: { createdAt: 'asc' } });
    const header = ['telefone', 'nome', 'status', 'numero', 'enviada_em', 'entregue_em', 'lida_em', 'respondida_em', 'descadastro_em', 'motivo', 'mensagem'];
    const lines = rows.map((r) =>
      [r.contact.phone, r.contact.name, r.status, r.number?.nickname, r.sentAt, r.deliveredAt, r.readAt, r.repliedAt, r.optedOutAt, r.skipReason ?? r.error, r.renderedText].map(csvCell).join(';'),
    );
    const fileName = encodeURIComponent(`campanha-${c.name}.csv`);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename*=UTF-8''${fileName}`);
    return `﻿${header.join(';')}\n${lines.join('\n')}\n`;
  });
}
