import { BlacklistSource, MessageSource, MessageStatus, MessageType, RecipientStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { audit } from '../lib/audit.js';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { outboundQueue } from '../lib/queues.js';
import { getSetting } from '../lib/settings.js';

const DAY = 86_400_000;

/** Entregue/lida de uma mensagem de campanha → destinatário (idempotente). */
export async function trackCampaignReceipt(messageId: string, status: MessageStatus): Promise<void> {
  const delivered = status === MessageStatus.DELIVERED || status === MessageStatus.READ || status === MessageStatus.PLAYED;
  const read = status === MessageStatus.READ || status === MessageStatus.PLAYED;
  if (!delivered) return;
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { campaignRecipientId: true } });
  if (!msg?.campaignRecipientId) return;
  const id = msg.campaignRecipientId;
  const now = new Date();
  await prisma.campaignRecipient.updateMany({ where: { id, deliveredAt: null }, data: { deliveredAt: now } });
  if (read) await prisma.campaignRecipient.updateMany({ where: { id, readAt: null }, data: { readAt: now } });
  await prisma.campaignRecipient.updateMany({
    where: { id, status: { in: read ? [RecipientStatus.SENT, RecipientStatus.DELIVERED] : [RecipientStatus.SENT] } },
    data: { status: read ? RecipientStatus.READ : RecipientStatus.DELIVERED },
  });
}

/** Compara sem caixa, acento, pontuação ou espaços nas pontas: "Sair!" == "SAIR". */
export const normalizeKeyword = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, '').trim().replace(/\s+/g, ' ').toUpperCase();

export interface InboundContext {
  numberId: string;
  conversationId: string;
  text: string | null;
  timestamp: Date;
}

/**
 * Chamado para cada mensagem recebida em conversa individual:
 * marca a campanha como respondida e trata o pedido de descadastro.
 * Devolve optedOut=true para que nenhuma automação responda em seguida.
 */
export async function handleInbound(ctx: InboundContext): Promise<{ optedOut: boolean }> {
  const conv = await prisma.conversation.findUnique({ where: { id: ctx.conversationId }, select: { contactId: true, contact: { select: { phone: true, optedOutAt: true } } } });
  if (!conv?.contactId || !conv.contact) return { optedOut: false };
  const contactId = conv.contactId;

  // Resposta: a campanha mais recente enviada por este número a este contato, nos últimos 7 dias.
  const recent = await prisma.campaignRecipient.findFirst({
    where: { contactId, numberId: ctx.numberId, sentAt: { gte: new Date(Date.now() - 7 * DAY) } },
    orderBy: { sentAt: 'desc' },
    select: { id: true, campaignId: true, repliedAt: true },
  });
  if (recent && !recent.repliedAt) {
    await prisma.campaignRecipient.updateMany({ where: { id: recent.id, repliedAt: null }, data: { repliedAt: new Date() } });
    await publishEvent({ type: 'campaign.updated', payload: { campaignId: recent.campaignId } });
  }

  const optOut = await getSetting('optOut');
  if (!ctx.text || !optOut.keywords.map(normalizeKeyword).includes(normalizeKeyword(ctx.text))) return { optedOut: false };

  const firstTime = !conv.contact.optedOutAt;
  const now = new Date();
  await prisma.blacklistEntry.upsert({
    where: { phone: conv.contact.phone },
    create: { phone: conv.contact.phone, source: BlacklistSource.OPT_OUT, reason: `Enviou "${ctx.text.trim().slice(0, 30)}"` },
    update: {},
  });
  await prisma.contact.update({ where: { id: contactId }, data: { optedOutAt: conv.contact.optedOutAt ?? now } });
  await prisma.campaignRecipient.updateMany({ where: { contactId, status: RecipientStatus.QUEUED }, data: { status: RecipientStatus.SKIPPED, skipReason: 'opt-out' } });
  if (recent) {
    await prisma.campaignRecipient.updateMany({ where: { id: recent.id, optedOutAt: null }, data: { optedOutAt: now } });
    await publishEvent({ type: 'campaign.updated', payload: { campaignId: recent.campaignId } });
  }
  logger.info({ contactId, numberId: ctx.numberId }, 'contato descadastrado por palavra-chave');
  await audit({ action: 'contact.opt_out', entity: 'Contact', entityId: contactId, meta: { numberId: ctx.numberId } });

  // Confirmação única, e só para pedidos recentes (não responde a mensagens antigas sincronizadas depois).
  if (firstTime && ctx.timestamp.getTime() > Date.now() - DAY) {
    const message = await prisma.message.create({
      data: {
        conversationId: ctx.conversationId,
        numberId: ctx.numberId,
        waMessageId: `pending:${randomUUID()}`,
        fromMe: true,
        source: MessageSource.AUTOMATION,
        type: MessageType.TEXT,
        status: MessageStatus.PENDING,
        text: optOut.confirmation,
        timestamp: new Date(),
      },
    });
    await prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { lastMessageAt: message.timestamp, lastMessagePreview: optOut.confirmation.slice(0, 200), lastMessageFromMe: true },
    });
    await outboundQueue.add('send', { kind: 'send', messageId: message.id });
    await publishEvent({ type: 'message.new', numberId: ctx.numberId, payload: { conversationId: ctx.conversationId, messageId: message.id } });
  }
  return { optedOut: true };
}
