import { MessageType, type Media, type Message, type Prisma } from '@prisma/client';
import { signedMediaPath } from '../../lib/media-url.js';
import { prisma } from '../../lib/prisma.js';

export const conversationInclude = {
  number: { select: { id: true, nickname: true, color: true, phone: true, status: true } },
  contact: { select: { id: true, name: true, phone: true, pushName: true, company: true, optedOutAt: true } },
  assignee: { select: { id: true, name: true } },
  tags: { include: { tag: true } },
} satisfies Prisma.ConversationInclude;

type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

export function conversationDto(c: ConversationRow) {
  return {
    id: c.id,
    isGroup: c.isGroup,
    // Nome exibido: cadastro do contato > título (grupo/pushName) > telefone.
    name: c.contact?.name ?? c.title ?? c.contact?.pushName ?? c.contact?.phone ?? 'Contato sem telefone visível',
    status: c.status,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    lastMessageFromMe: c.lastMessageFromMe,
    automationPaused: Boolean(c.automationPausedAt),
    number: c.number,
    contact: c.contact,
    assignee: c.assignee,
    tags: c.tags.map((t) => t.tag),
  };
}

function mediaDto(m: Media) {
  return {
    id: m.id,
    status: m.status,
    mimeType: m.mimeType,
    fileName: m.fileName,
    size: m.size,
    durationS: m.durationS,
    isPtt: m.isPtt,
    error: m.error,
    url: m.status === 'STORED' ? signedMediaPath(m.id) : null,
  };
}

type MessageRow = Message & { media: Media | null; sentBy: { id: string; name: string } | null };
export const messageInclude = { media: true, sentBy: { select: { id: true, name: true } } } satisfies Prisma.MessageInclude;

/**
 * Converte mensagens para o painel, anexando em lote a mensagem citada e as
 * reações (que são gravadas como mensagens do tipo REACTION).
 */
export async function messagesDto(numberId: string, rows: MessageRow[]) {
  const quotedIds = [...new Set(rows.map((r) => r.quotedWaId).filter((id): id is string => Boolean(id)))];
  const waIds = rows.map((r) => r.waMessageId);
  const [quoted, reactions] = await Promise.all([
    quotedIds.length
      ? prisma.message.findMany({
          where: { numberId, waMessageId: { in: quotedIds } },
          select: { waMessageId: true, text: true, type: true, fromMe: true, pushName: true },
        })
      : [],
    waIds.length
      ? prisma.message.findMany({
          where: { numberId, type: MessageType.REACTION, quotedWaId: { in: waIds } },
          orderBy: { timestamp: 'asc' },
          select: { quotedWaId: true, text: true, fromMe: true, participantJid: true },
        })
      : [],
  ]);
  const quotedMap = new Map(quoted.map((q) => [q.waMessageId, q]));

  // Uma reação por pessoa: a mais recente vale; texto vazio = reação removida.
  const reactionMap = new Map<string, Map<string, string | null>>();
  for (const r of reactions) {
    if (!r.quotedWaId) continue;
    const perSender = reactionMap.get(r.quotedWaId) ?? new Map();
    perSender.set(r.fromMe ? 'me' : (r.participantJid ?? 'contact'), r.text);
    reactionMap.set(r.quotedWaId, perSender);
  }

  return rows.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    fromMe: m.fromMe,
    source: m.source,
    type: m.type,
    status: m.status,
    text: m.text,
    timestamp: m.timestamp,
    pushName: m.pushName,
    participantJid: m.participantJid,
    editedAt: m.editedAt,
    revokedAt: m.revokedAt,
    error: m.error,
    sentBy: m.sentBy,
    media: m.media ? mediaDto(m.media) : null,
    quoted: m.quotedWaId ? (quotedMap.get(m.quotedWaId) ?? null) : null,
    reactions: [...(reactionMap.get(m.waMessageId)?.values() ?? [])].filter((e): e is string => Boolean(e)),
  }));
}
