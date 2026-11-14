import { CampaignStatus, ConversationStatus, Role } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { campaignStats } from '../../campaigns/audience.js';
import { dailyCap } from '../../campaigns/rules.js';
import { prisma } from '../../lib/prisma.js';
import { getSetting } from '../../lib/settings.js';
import { localDay } from '../../lib/time.js';
import { accessibleNumberIds, authenticate } from '../auth/guard.js';

const query = z.object({ days: z.coerce.number().int().min(7).max(90).default(14) });

/** Visão geral. O atendente vê só os números atribuídos a ele e não vê campanhas. */
export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (req) => {
    const { days } = query.parse(req.query);
    const ids = await accessibleNumberIds(req.user);
    const numberScope = ids ? { id: { in: ids } } : {};
    const statScope = ids ? { numberId: { in: ids } } : {};
    const today = localDay();
    const from = new Date(today.getTime() - (days - 1) * 86_400_000);
    const isManager = req.user.role !== Role.AGENT;

    const [numbers, stats, antiBan, convCounts, unread] = await Promise.all([
      prisma.waNumber.findMany({ where: { deletedAt: null, ...numberScope }, orderBy: { createdAt: 'asc' }, include: { dailyStats: { where: { date: today } } } }),
      prisma.numberDailyStat.groupBy({ by: ['date'], where: { date: { gte: from }, ...statScope }, _sum: { sent: true, received: true, campaignSent: true, failed: true } }),
      getSetting('antiBan'),
      prisma.conversation.groupBy({ by: ['status'], where: { lastMessageAt: { not: null }, ...statScope }, _count: true }),
      prisma.conversation.aggregate({ where: { unreadCount: { gt: 0 }, ...statScope }, _count: true, _sum: { unreadCount: true } }),
    ]);

    // Série diária completa (dias sem movimento entram como zero).
    const byDate = new Map(stats.map((s) => [s.date.toISOString().slice(0, 10), s._sum]));
    const series = Array.from({ length: days }, (_, i) => {
      const date = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const sum = byDate.get(date);
      return { date, sent: sum?.sent ?? 0, received: sum?.received ?? 0, campaignSent: sum?.campaignSent ?? 0, failed: sum?.failed ?? 0 };
    });

    // Taxa de resposta das campanhas no período: de quem recebeu, quantos responderam.
    const recipientScope = { sentAt: { gte: from }, ...(ids ? { numberId: { in: ids } } : {}) };
    const [campaignSent, campaignReplied, campaignDelivered] = await Promise.all([
      prisma.campaignRecipient.count({ where: recipientScope }),
      prisma.campaignRecipient.count({ where: { ...recipientScope, repliedAt: { not: null } } }),
      prisma.campaignRecipient.count({ where: { ...recipientScope, deliveredAt: { not: null } } }),
    ]);

    let campaigns: unknown[] = [];
    if (isManager) {
      const active = await prisma.campaign.findMany({
        where: { status: { in: [CampaignStatus.RUNNING, CampaignStatus.SCHEDULED, CampaignStatus.PAUSED] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, name: true, status: true, scheduledAt: true },
      });
      const cStats = await campaignStats(active.map((c) => c.id));
      campaigns = active.map((c) => ({ ...c, stats: cStats.get(c.id) }));
    }

    const count = (s: ConversationStatus) => convCounts.find((c) => c.status === s)?._count ?? 0;
    return {
      days,
      numbers: numbers.map((n) => {
        const t = n.dailyStats[0];
        return {
          id: n.id,
          nickname: n.nickname,
          color: n.color,
          phone: n.phone,
          status: n.status,
          statusReason: n.statusReason,
          campaignEnabled: n.campaignEnabled,
          warmupEnabled: n.warmupEnabled,
          dailyLimit: n.dailyLimit,
          capToday: dailyCap(n, antiBan),
          today: { sent: t?.sent ?? 0, received: t?.received ?? 0, campaignSent: t?.campaignSent ?? 0, delivered: t?.delivered ?? 0, failed: t?.failed ?? 0 },
        };
      }),
      series,
      totals: {
        sent: series.reduce((a, s) => a + s.sent, 0),
        received: series.reduce((a, s) => a + s.received, 0),
        campaignSent,
        campaignDelivered,
        campaignReplied,
      },
      conversations: { open: count(ConversationStatus.OPEN), pending: count(ConversationStatus.PENDING), unreadConversations: unread._count, unreadMessages: unread._sum.unreadCount ?? 0 },
      campaigns,
    };
  });
}
