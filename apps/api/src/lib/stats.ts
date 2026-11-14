import { prisma } from './prisma.js';
import { localDay } from './time.js';

export type StatField = 'sent' | 'received' | 'delivered' | 'read' | 'failed' | 'campaignSent';

/** Soma 1 no contador diário do número (limite diário, aquecimento e dashboard). */
export async function bumpDailyStat(numberId: string, field: StatField): Promise<void> {
  const date = localDay();
  await prisma.numberDailyStat.upsert({
    where: { numberId_date: { numberId, date } },
    create: { numberId, date, [field]: 1 },
    update: { [field]: { increment: 1 } },
  });
}
