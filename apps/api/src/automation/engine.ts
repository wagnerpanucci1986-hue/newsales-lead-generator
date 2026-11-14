import { AutomationAction, AutomationTrigger, ConversationStatus, KeywordMatch, MessageSource, MessageStatus, MessageType, type AutomationRule } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { inSendWindow } from '../campaigns/rules.js';
import { handleInbound, normalizeKeyword, type InboundContext } from '../campaigns/tracking.js';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { outboundQueue } from '../lib/queues.js';
import { getSetting } from '../lib/settings.js';
import { renderTemplate } from '../lib/template.js';

// Só responde a mensagens recém-chegadas: nada de responder ao que foi sincronizado horas depois.
const MAX_AGE_MS = 5 * 60_000;

export function matchesKeyword(rule: Pick<AutomationRule, 'matchType' | 'keywords'>, text: string): boolean {
  const body = normalizeKeyword(text);
  if (!body) return false;
  return rule.keywords.map(normalizeKeyword).filter(Boolean).some((kw) => {
    if (rule.matchType === KeywordMatch.EXACT) return body === kw;
    if (rule.matchType === KeywordMatch.STARTS_WITH) return body === kw || body.startsWith(`${kw} `);
    // CONTAINS: palavra inteira, para "oi" não casar com "coisa"
    return ` ${body} `.includes(` ${kw} `);
  });
}

/**
 * Ponto único de tratamento de uma mensagem recebida em conversa individual:
 * 1) resposta de campanha e descadastro; 2) respostas automáticas.
 */
export async function processInbound(ctx: InboundContext, now = new Date()): Promise<void> {
  const { optedOut } = await handleInbound(ctx);
  if (optedOut) return;
  await runAutomations(ctx, now);
}

export async function runAutomations(ctx: InboundContext, now = new Date()): Promise<'replied' | 'handoff' | null> {
  if (now.getTime() - ctx.timestamp.getTime() > MAX_AGE_MS) return null;
  const conv = await prisma.conversation.findUnique({ where: { id: ctx.conversationId }, include: { contact: true } });
  // Um humano assumiu a conversa: a automação fica quieta até ela ser encerrada.
  if (!conv || conv.isGroup || conv.automationPausedAt) return null;
  if (conv.contact?.optedOutAt) return null;
  if (conv.contact && (await prisma.blacklistEntry.findUnique({ where: { phone: conv.contact.phone } }))) return null;

  const rules = await prisma.automationRule.findMany({
    where: { enabled: true, OR: [{ numberId: null }, { numberId: ctx.numberId }] },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });
  if (!rules.length) return null;
  const hours = await getSetting('businessHours');
  const open = inSendWindow({ timezone: hours.timezone, sendDays: hours.days, windowStart: hours.start, windowEnd: hours.end }, now);

  // A primeira regra que casar (por prioridade) vence. Palavra-chave tem precedência natural se tiver prioridade maior.
  const rule = rules.find((r) => (r.trigger === AutomationTrigger.OUT_OF_HOURS ? !open : Boolean(ctx.text) && matchesKeyword(r, ctx.text!)));
  if (!rule) return null;

  // Intervalo mínimo por regra e por conversa: evita repetir a mesma resposta e laços entre dois robôs.
  const eventType = `automation:${rule.id}`;
  const last = await prisma.conversationEvent.findFirst({ where: { conversationId: conv.id, type: eventType }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (last && now.getTime() - last.createdAt.getTime() < rule.cooldownMinutes * 60_000) return null;

  await prisma.conversationEvent.create({ data: { conversationId: conv.id, type: eventType, data: { rule: rule.name, action: rule.action } } });

  const text = rule.responseText ? renderTemplate(rule.responseText, conv.contact ?? { phone: '', name: conv.title }) : '';
  if (text) {
    const message = await prisma.message.create({
      data: {
        conversationId: conv.id,
        numberId: ctx.numberId,
        waMessageId: `pending:${randomUUID()}`,
        fromMe: true,
        source: MessageSource.AUTOMATION,
        type: MessageType.TEXT,
        status: MessageStatus.PENDING,
        text,
        timestamp: now,
      },
    });
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: now, lastMessagePreview: text.replace(/\s+/g, ' ').slice(0, 200), lastMessageFromMe: true } });
    await outboundQueue.add('send', { kind: 'send', messageId: message.id });
    await publishEvent({ type: 'message.new', numberId: ctx.numberId, payload: { conversationId: conv.id, messageId: message.id } });
  }

  if (rule.action === AutomationAction.HANDOFF) {
    // Encaminha para um humano: entra na fila "Pendente" e a automação para de responder.
    await prisma.conversation.update({ where: { id: conv.id }, data: { status: ConversationStatus.PENDING, automationPausedAt: now } });
    await prisma.conversationEvent.create({ data: { conversationId: conv.id, type: 'handoff', data: { rule: rule.name } } });
  }
  await publishEvent({ type: 'conversation.updated', numberId: ctx.numberId, payload: { conversationId: conv.id } });
  logger.info({ conversationId: conv.id, rule: rule.name, action: rule.action }, 'resposta automática');
  return rule.action === AutomationAction.HANDOFF ? 'handoff' : 'replied';
}
