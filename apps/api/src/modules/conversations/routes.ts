import { ConversationStatus, MediaStatus, MessageSource, MessageStatus, MessageType, Role, type Prisma, type User } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { publishEvent } from '../../lib/events.js';
import { prisma } from '../../lib/prisma.js';
import { MEDIA_PREVIEW_LABEL, messageTypeForMime } from '../../lib/media-type.js';
import { outboundQueue } from '../../lib/queues.js';
import { storage } from '../../lib/storage/index.js';
import { accessibleNumberIds, authenticate, HttpError } from '../auth/guard.js';
import { conversationDto, conversationInclude, messageInclude, messagesDto } from './dto.js';

const listQuery = z.object({
  numberId: z.string().optional(),
  status: z.enum(ConversationStatus).optional(),
  tagId: z.string().optional(),
  // "me" = minhas, "none" = sem responsável, ou o id de um usuário
  assignee: z.string().optional(),
  unread: z.enum(['1']).optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const messagesQuery = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const idParams = z.object({ id: z.string().min(1) });
const patchBody = z.object({
  status: z.enum(ConversationStatus).optional(),
  assignedUserId: z.string().nullable().optional(),
});
const tagsBody = z.object({ tagIds: z.array(z.string()).max(20) });
const textBody = z.object({ text: z.string().trim().min(1).max(4096) });

/** Filtro de acesso: atendente só enxerga conversas dos números atribuídos a ele. */
async function scope(user: User): Promise<Prisma.ConversationWhereInput> {
  const ids = await accessibleNumberIds(user);
  return ids ? { numberId: { in: ids } } : {};
}

async function findConversation(user: User, id: string) {
  const conv = await prisma.conversation.findFirst({ where: { id, ...(await scope(user)) }, include: conversationInclude });
  if (!conv) throw new HttpError(404, 'Conversa não encontrada');
  return conv;
}

export async function conversationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Caixa de entrada unificada, da conversa mais recente para a mais antiga.
  app.get('/', async (req) => {
    const q = listQuery.parse(req.query);
    const and: Prisma.ConversationWhereInput[] = [await scope(req.user), { lastMessageAt: { not: null } }];

    if (q.numberId) and.push({ numberId: q.numberId });
    if (q.status) and.push({ status: q.status });
    if (q.tagId) and.push({ tags: { some: { tagId: q.tagId } } });
    if (q.unread) and.push({ unreadCount: { gt: 0 } });
    if (q.assignee === 'me') and.push({ assignedUserId: req.user.id });
    else if (q.assignee === 'none') and.push({ assignedUserId: null });
    else if (q.assignee) and.push({ assignedUserId: q.assignee });

    if (q.q) {
      const contains = { contains: q.q, mode: 'insensitive' as const };
      const digits = q.q.replace(/\D/g, '');
      and.push({
        OR: [
          { title: contains },
          { contact: { OR: [{ name: contains }, { pushName: contains }, { company: contains }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])] } },
          { messages: { some: { text: contains } } },
        ],
      });
    }

    // Paginação por cursor (data da última mensagem + id), estável mesmo com conversas chegando.
    if (q.cursor) {
      const [iso, id] = q.cursor.split('|');
      const at = new Date(iso ?? '');
      if (!id || Number.isNaN(at.getTime())) throw new HttpError(400, 'Cursor inválido');
      and.push({ OR: [{ lastMessageAt: { lt: at } }, { lastMessageAt: at, id: { lt: id } }] });
    }

    const rows = await prisma.conversation.findMany({
      where: { AND: and },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: conversationInclude,
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      conversations: page.map(conversationDto),
      nextCursor: rows.length > q.limit && last?.lastMessageAt ? `${last.lastMessageAt.toISOString()}|${last.id}` : null,
    };
  });

  app.get('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    return { conversation: conversationDto(await findConversation(req.user, id)) };
  });

  // Histórico: sem cursor devolve as mais recentes; "before" pagina para trás; "after" traz as novas.
  app.get('/:id/messages', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = messagesQuery.parse(req.query);
    const conv = await findConversation(req.user, id);

    const where: Prisma.MessageWhereInput = { conversationId: id, type: { not: MessageType.REACTION } };
    const anchorId = q.after ?? q.before;
    if (anchorId) {
      const anchor = await prisma.message.findFirst({ where: { id: anchorId, conversationId: id }, select: { timestamp: true, id: true } });
      if (!anchor) throw new HttpError(400, 'Mensagem de referência não encontrada');
      where.OR = q.after
        ? [{ timestamp: { gt: anchor.timestamp } }, { timestamp: anchor.timestamp, id: { gt: anchor.id } }]
        : [{ timestamp: { lt: anchor.timestamp } }, { timestamp: anchor.timestamp, id: { lt: anchor.id } }];
    }
    const dir = q.after ? 'asc' : 'desc';
    const rows = await prisma.message.findMany({
      where,
      orderBy: [{ timestamp: dir }, { id: dir }],
      take: q.limit + 1,
      include: messageInclude,
    });
    const page = rows.slice(0, q.limit);
    if (!q.after) page.reverse(); // sempre em ordem cronológica
    return { messages: await messagesDto(conv.numberId, page), hasMore: rows.length > q.limit };
  });

  app.get('/:id/messages/:messageId', async (req) => {
    const { id, messageId } = z.object({ id: z.string(), messageId: z.string() }).parse(req.params);
    const conv = await findConversation(req.user, id);
    const row = await prisma.message.findFirst({ where: { id: messageId, conversationId: id }, include: messageInclude });
    if (!row) throw new HttpError(404, 'Mensagem não encontrada');
    return { message: (await messagesDto(conv.numberId, [row]))[0] };
  });

  // Responder pelo painel: JSON { text } ou multipart com "file" e "text" (legenda) opcionais.
  app.post('/:id/messages', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const conv = await findConversation(req.user, id);
    if (conv.number.status !== 'CONNECTED' && conv.number.status !== 'SUSPECT') throw new HttpError(409, 'O número desta conversa está desconectado.');

    let text: string | null = null;
    let type: MessageType = MessageType.TEXT;
    let media: Prisma.MediaCreateWithoutMessageInput | undefined;

    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new HttpError(400, 'Envie um arquivo');
      const buffer = await file.toBuffer(); // estoura com 413 acima de MAX_UPLOAD_MB
      if (!buffer.length) throw new HttpError(400, 'Arquivo vazio');
      const caption = (file.fields.text as { value?: string } | undefined)?.value?.trim();
      text = caption ? caption.slice(0, 4096) : null;
      const mimeType = file.mimetype || 'application/octet-stream';
      type = messageTypeForMime(mimeType);
      const fileName = path.basename(file.filename || 'arquivo').slice(0, 200);
      const ext = path.extname(fileName).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 9);
      const storageKey = `${conv.number.id}/enviados/${new Date().toISOString().slice(0, 7)}/${randomUUID()}${ext}`;
      await storage.put(storageKey, buffer, mimeType);
      media = { status: MediaStatus.STORED, storageKey, mimeType, fileName, size: buffer.length, sha256: sha256(buffer), isPtt: false };
    } else {
      text = textBody.parse(req.body).text;
    }

    const now = new Date();
    const message = await prisma.message.create({
      data: {
        conversationId: id,
        numberId: conv.number.id,
        // Provisório: o worker troca pelo id real do WhatsApp logo antes de enviar.
        waMessageId: `pending:${randomUUID()}`,
        fromMe: true,
        source: MessageSource.PANEL,
        type,
        status: MessageStatus.PENDING,
        text,
        timestamp: now,
        sentByUserId: req.user.id,
        media: media ? { create: media } : undefined,
      },
      include: messageInclude,
    });

    // Um humano assumiu: zera não lidas, pausa a automação e, sem responsável, atribui a quem respondeu.
    await prisma.conversation.update({
      where: { id },
      data: {
        lastMessageAt: now,
        lastMessagePreview: [MEDIA_PREVIEW_LABEL[type], text].filter(Boolean).join(': ').replace(/\s+/g, ' ').slice(0, 200),
        lastMessageFromMe: true,
        unreadCount: 0,
        automationPausedAt: conv.automationPausedAt ?? now,
        status: conv.status === ConversationStatus.CLOSED ? ConversationStatus.OPEN : undefined,
        assignedUserId: conv.assignedUserId ?? req.user.id,
      },
    });
    await outboundQueue.add('send', { kind: 'send', messageId: message.id });
    await publishEvent({ type: 'message.new', numberId: conv.number.id, payload: { conversationId: id, messageId: message.id } });
    // Responsável e status podem ter mudado junto com o envio.
    await publishEvent({ type: 'conversation.updated', numberId: conv.number.id, payload: { conversationId: id } });
    return reply.code(202).send({ message: (await messagesDto(conv.number.id, [message]))[0] });
  });

  // Abrir a conversa: zera não lidas no painel e envia os recibos de leitura ao contato.
  app.post('/:id/read', async (req) => {
    const { id } = idParams.parse(req.params);
    const conv = await findConversation(req.user, id);
    if (conv.unreadCount > 0) {
      await prisma.conversation.update({ where: { id }, data: { unreadCount: 0 } });
      await publishEvent({ type: 'conversation.updated', numberId: conv.number.id, payload: { conversationId: id } });
    }
    await outboundQueue.add('read', { kind: 'read', conversationId: id });
    return { ok: true };
  });

  // Status e responsável.
  app.patch('/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const conv = await findConversation(req.user, id);
    const data: Prisma.ConversationUncheckedUpdateInput = {};

    if (body.assignedUserId !== undefined && body.assignedUserId !== conv.assignedUserId) {
      // Atendente só pode assumir para si ou devolver à fila.
      if (req.user.role === Role.AGENT && body.assignedUserId !== null && body.assignedUserId !== req.user.id) {
        throw new HttpError(403, 'Atendentes só podem assumir a conversa ou devolvê-la à fila');
      }
      if (body.assignedUserId) {
        const target = await prisma.user.findFirst({ where: { id: body.assignedUserId, active: true }, select: { id: true, role: true } });
        if (!target) throw new HttpError(400, 'Usuário não encontrado');
        const allowed = await accessibleNumberIds(target);
        if (allowed && !allowed.includes(conv.number.id)) throw new HttpError(400, 'Este usuário não tem acesso ao número da conversa');
      }
      data.assignedUserId = body.assignedUserId;
    }
    if (body.status && body.status !== conv.status) {
      data.status = body.status;
      // Ao encerrar, a automação volta a valer para o próximo contato do cliente.
      if (body.status === ConversationStatus.CLOSED) data.automationPausedAt = null;
    }
    if (!Object.keys(data).length) return { conversation: conversationDto(conv) };

    const updated = await prisma.conversation.update({ where: { id }, data, include: conversationInclude });
    await prisma.conversationEvent.create({
      data: { conversationId: id, userId: req.user.id, type: data.status ? `status:${String(data.status).toLowerCase()}` : 'assigned', data: body },
    });
    await audit({ userId: req.user.id, action: 'conversation.update', entity: 'Conversation', entityId: id, meta: body, ip: req.ip });
    await publishEvent({ type: 'conversation.updated', numberId: conv.number.id, payload: { conversationId: id } });
    return { conversation: conversationDto(updated) };
  });

  app.put('/:id/tags', async (req) => {
    const { id } = idParams.parse(req.params);
    const { tagIds } = tagsBody.parse(req.body);
    const conv = await findConversation(req.user, id);
    const valid = await prisma.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true } });
    await prisma.$transaction([
      prisma.conversationTag.deleteMany({ where: { conversationId: id } }),
      prisma.conversationTag.createMany({ data: valid.map((t) => ({ conversationId: id, tagId: t.id })) }),
    ]);
    await publishEvent({ type: 'conversation.updated', numberId: conv.number.id, payload: { conversationId: id } });
    return { conversation: conversationDto(await findConversation(req.user, id)) };
  });
}
