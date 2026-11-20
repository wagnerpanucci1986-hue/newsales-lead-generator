import { AiStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getSetting } from '../lib/settings.js';

const DAY = 86_400_000;

/**
 * Campanha com SDR: depois da 1ª mensagem, a IA assume a conversa (se ninguém a desligou)
 * e agenda o primeiro follow-up. Conversa já atendida por humano não é tocada.
 */
export async function activateSdr(conversationId: string, campaignId: string, now = new Date()): Promise<void> {
  const cfg = await getSetting('sdr');
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { aiStatus: true, automationPausedAt: true } });
  // Encerrada pela IA (frio, descadastro) ou com humano: uma nova campanha não reabre sozinha.
  if (!conv || conv.automationPausedAt || conv.aiStatus === AiStatus.DONE) return;
  if (conv.aiStatus === AiStatus.OFF) await prisma.conversation.update({ where: { id: conversationId }, data: { aiStatus: AiStatus.ACTIVE } });
  const next = cfg.followUpDays[0] ? new Date(now.getTime() + cfg.followUpDays[0] * DAY) : null;
  await prisma.sdrLead.upsert({
    where: { conversationId },
    create: { conversationId, campaignId, nextFollowUpAt: next },
    update: { campaignId, followUpCount: 0, nextFollowUpAt: next },
  });
}
