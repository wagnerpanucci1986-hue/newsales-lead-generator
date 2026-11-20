import { AiStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { sdrQueue } from '../lib/queues.js';
import { getSetting } from '../lib/settings.js';
import { hasApiKey } from './model.js';

const MAX_AGE_MS = 5 * 60_000;

/**
 * Mensagem nova do lead numa conversa atendida pela IA: agenda a resposta depois de
 * `replyDelaySeconds` (junta mensagens seguidas). Devolve true se a IA vai cuidar dela,
 * para as respostas automáticas comuns não responderem junto.
 */
export async function queueSdrReply(ctx: { conversationId: string; timestamp: Date }, now = new Date()): Promise<boolean> {
  const conv = await prisma.conversation.findUnique({ where: { id: ctx.conversationId }, select: { aiStatus: true, automationPausedAt: true, isGroup: true } });
  if (!conv || conv.isGroup || conv.aiStatus !== AiStatus.ACTIVE || conv.automationPausedAt) return false;
  const cfg = await getSetting('sdr');
  if (!cfg.enabled || !hasApiKey()) return false;
  if (now.getTime() - ctx.timestamp.getTime() > MAX_AGE_MS) return true; // antiga (sincronização): ninguém responde
  const triggerAt = ctx.timestamp.getTime();
  await sdrQueue.add('reply', { kind: 'reply', conversationId: ctx.conversationId, triggerAt }, { jobId: `reply-${ctx.conversationId}-${triggerAt}`, delay: cfg.replyDelaySeconds * 1000 });
  return true;
}

/** Descadastro por palavra-chave: a IA encerra junto. */
export async function stopSdrOnOptOut(conversationId: string): Promise<void> {
  await prisma.conversation.updateMany({ where: { id: conversationId, aiStatus: AiStatus.ACTIVE }, data: { aiStatus: AiStatus.DONE } });
  await prisma.sdrLead.updateMany({ where: { conversationId }, data: { nextFollowUpAt: null, stage: 'ENCERRADO', temperature: 'FRIO', motivo: 'Descadastro por palavra-chave' } });
}
