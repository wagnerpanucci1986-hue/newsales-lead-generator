import { AiStatus, LeadStage } from '@prisma/client';
import { inSendWindow } from '../campaigns/rules.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { sdrQueue } from '../lib/queues.js';
import { getSetting } from '../lib/settings.js';
import { hasApiKey } from './model.js';
import { localDate } from './slots.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const sameDay = (tz: string, a: Date, b: Date) => {
  const x = localDate(tz, a);
  const y = localDate(tz, b);
  return x.y === y.y && x.m === y.m && x.d === y.d;
};

/**
 * Roda a cada minuto no worker: enfileira follow-ups vencidos (só no horário de atendimento,
 * espaçados entre si) e lembretes de reunião (véspera e no dia). Ids fixos evitam repetição.
 */
export async function sdrTick(now = new Date(), random: () => number = Math.random): Promise<{ followups: number; reminders: number }> {
  const cfg = await getSetting('sdr');
  if (!cfg.enabled || !hasApiKey()) return { followups: 0, reminders: 0 };
  const hours = await getSetting('businessHours');
  const tz = hours.timezone;
  const open = inSendWindow({ timezone: tz, sendDays: hours.days, windowStart: hours.start, windowEnd: hours.end }, now);
  const activeConv = { aiStatus: AiStatus.ACTIVE, automationPausedAt: null };
  let followups = 0;
  let reminders = 0;

  if (open) {
    const due = await prisma.sdrLead.findMany({
      where: { nextFollowUpAt: { lte: now }, stage: { notIn: [LeadStage.AGENDADO, LeadStage.ENCERRADO] }, conversation: activeConv },
      orderBy: { nextFollowUpAt: 'asc' },
      take: 30,
    });
    let delay = 0;
    for (const lead of due) {
      await sdrQueue.add('followup', { kind: 'followup', conversationId: lead.conversationId }, { jobId: `followup-${lead.id}-${lead.nextFollowUpAt!.getTime()}`, delay });
      // Vários follow-ups vencidos ao mesmo tempo saem espaçados, como numa campanha.
      delay += Math.round((40 + random() * 80) * 1000);
      followups++;
    }
  }

  const meetings = await prisma.sdrLead.findMany({
    where: { stage: LeadStage.AGENDADO, meetingStart: { gt: now, lt: new Date(now.getTime() + 2 * DAY) }, conversation: activeConv, OR: [{ remindedDayBefore: false }, { remindedSameDay: false }] },
  });
  for (const m of meetings) {
    const start = m.meetingStart!;
    const untilMs = start.getTime() - now.getTime();
    if (!m.remindedDayBefore && open && sameDay(tz, start, new Date(now.getTime() + DAY)) && untilMs > 3 * HOUR) {
      await sdrQueue.add('reminder', { kind: 'reminder', conversationId: m.conversationId, when: 'vespera' }, { jobId: `reminder-${m.id}-vespera-${start.getTime()}` });
      reminders++;
    } else if (!m.remindedSameDay && sameDay(tz, start, now) && untilMs <= 2 * HOUR && untilMs > 15 * 60_000) {
      await sdrQueue.add('reminder', { kind: 'reminder', conversationId: m.conversationId, when: 'dia' }, { jobId: `reminder-${m.id}-dia-${start.getTime()}` });
      reminders++;
    }
  }
  if (followups || reminders) logger.info({ followups, reminders }, 'IA do SDR: tarefas agendadas');
  return { followups, reminders };
}
