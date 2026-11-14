import { CampaignStatus, MediaStatus, MessageSource, MessageStatus, MessageType, NumberStatus, RecipientStatus, WaCheckStatus, type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { audit } from '../lib/audit.js';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { MEDIA_PREVIEW_LABEL, messageTypeForMime } from '../lib/media-type.js';
import { isUniqueViolation, prisma } from '../lib/prisma.js';
import { campaignQueue } from '../lib/queues.js';
import { getSetting } from '../lib/settings.js';
import { bumpDailyStat } from '../lib/stats.js';
import { renderTemplate } from '../lib/template.js';
import { localDay } from '../lib/time.js';
import { brPhoneVariants } from '../whatsapp/jid.js';
import { sendPendingMessage, type SocketProvider } from '../whatsapp/sender.js';
import { dailyCap, inSendWindow, msUntilNextLocalDay, randomBetween } from './rules.js';

export type TickOutcome = 'idle' | 'daily-limit' | 'out-of-window' | 'empty' | 'skipped' | 'sent' | 'failed';

interface Options {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

const DISPATCH_INTERVAL_MS = 2_000;
const MAINTENANCE_INTERVAL_MS = 20_000;
const STALE_SENDING_MS = 10 * 60_000;

/**
 * Motor de disparo. A fila durável é a tabela CampaignRecipient; cada número
 * tem seu próprio ritmo (WaNumber.nextSendAt), então reiniciar o worker não
 * perde nem duplica nada. Roda só no worker líder.
 */
export class CampaignDispatcher {
  private readonly busy = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => Date;

  constructor(
    private readonly sessions: SocketProvider,
    opts: Options = {},
  ) {
    this.sleep = opts.sleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.timers = [
      setInterval(() => void this.dispatch().catch((err) => logger.error({ err }, 'erro no ciclo de disparo')), DISPATCH_INTERVAL_MS),
      setInterval(() => void this.maintain().catch((err) => logger.error({ err }, 'erro na manutenção de campanhas')), MAINTENANCE_INTERVAL_MS),
    ];
    void this.maintain().catch((err) => logger.error({ err }, 'erro na manutenção de campanhas'));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** Um ciclo: cada número conectado, liberado e com campanha em andamento tenta um envio. */
  async dispatch(): Promise<void> {
    const now = this.now();
    const numbers = await prisma.waNumber.findMany({
      where: {
        deletedAt: null,
        status: NumberStatus.CONNECTED,
        campaignEnabled: true,
        OR: [{ nextSendAt: null }, { nextSendAt: { lte: now } }],
        campaigns: { some: { campaign: { status: CampaignStatus.RUNNING } } },
      },
      select: { id: true },
    });
    for (const { id } of numbers) {
      if (this.busy.has(id)) continue;
      this.busy.add(id);
      void this.tick(id)
        .catch((err) => logger.error({ err, numberId: id }, 'erro no envio de campanha'))
        .finally(() => this.busy.delete(id));
    }
  }

  /** Tenta enviar UMA mensagem de campanha por este número e agenda o próximo envio. */
  async tick(numberId: string): Promise<TickOutcome> {
    const now = this.now();
    const number = await prisma.waNumber.findFirst({ where: { id: numberId, deletedAt: null } });
    if (!number || number.status !== NumberStatus.CONNECTED || !number.campaignEnabled) return 'idle';
    const sock = this.sessions.getSocket(numberId);
    if (!sock?.user) return 'idle';

    const antiBan = await getSetting('antiBan');

    // Limite diário (com rampa de aquecimento).
    const stat = await prisma.numberDailyStat.findUnique({ where: { numberId_date: { numberId, date: localDay(now) } } });
    const sentToday = stat?.campaignSent ?? 0;
    if (sentToday >= dailyCap(number, antiBan, now)) {
      await this.defer(numberId, msUntilNextLocalDay(now));
      return 'daily-limit';
    }

    // Campanhas em andamento deste número que estão dentro da janela de envio.
    const campaigns = (await prisma.campaign.findMany({ where: { status: CampaignStatus.RUNNING, numbers: { some: { numberId } } } })).filter((c) => inSendWindow(c, now));
    if (!campaigns.length) {
      await this.defer(numberId, 60_000);
      return 'out-of-window';
    }

    // Reserva o próximo destinatário. SKIP LOCKED: dois números nunca pegam o mesmo contato.
    // Preferência por quem já tem conversa com este número (o contato reconhece o remetente).
    const ids = campaigns.map((c) => c.id);
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "CampaignRecipient" SET "status" = 'SENDING'::"RecipientStatus", "numberId" = ${numberId}, "claimedAt" = now(), "attempts" = "attempts" + 1, "updatedAt" = now()
      WHERE "id" = (
        SELECT r."id" FROM "CampaignRecipient" r
        WHERE r."campaignId" = ANY(${ids}) AND r."status" = 'QUEUED'::"RecipientStatus"
        ORDER BY EXISTS (SELECT 1 FROM "Conversation" c WHERE c."contactId" = r."contactId" AND c."numberId" = ${numberId}) DESC, r."createdAt", r."id"
        LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    if (!claimed[0]) {
      for (const c of campaigns) await this.completeIfDone(c.id);
      await this.defer(numberId, 30_000);
      return 'empty';
    }

    const recipient = await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: claimed[0].id }, include: { contact: true, campaign: { include: { media: true } } } });
    const { contact, campaign } = recipient;

    const skip = async (reason: string, deferMs: number): Promise<TickOutcome> => {
      await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: RecipientStatus.SKIPPED, skipReason: reason } });
      await this.defer(numberId, deferMs);
      await this.afterRecipient(campaign.id);
      return 'skipped';
    };

    // O contato pode ter saído ou entrado na blacklist depois que a campanha começou.
    if (contact.optedOutAt) return skip('opt-out', 500);
    if (await prisma.blacklistEntry.findUnique({ where: { phone: contact.phone } })) return skip('blacklist', 500);
    if (contact.waStatus === WaCheckStatus.INVALID) return skip('sem WhatsApp', 500);

    // Descobre o JID real (trata o 9º dígito) se ainda não foi verificado.
    let jid = contact.waJid;
    if (!jid) {
      const results = (await sock.onWhatsApp(contact.phone).catch(() => undefined)) ?? [];
      const byUser = new Map(results.filter((r) => r.exists).map((r) => [r.jid.split('@')[0]!.split(':')[0]!, r.jid]));
      jid = brPhoneVariants(contact.phone).map((v) => byUser.get(v)).find((j): j is string => Boolean(j)) ?? null;
      await prisma.contact.update({
        where: { id: contact.id },
        data: { waStatus: jid ? WaCheckStatus.VALID : WaCheckStatus.INVALID, waJid: jid, waCheckedAt: now },
      });
      // A consulta também conta como atividade: espera um pouco antes do próximo contato.
      if (!jid) return skip('sem WhatsApp', randomBetween(3_000, 6_000, this.random));
    }

    const text = renderTemplate(campaign.body, contact, this.random);
    const type = campaign.media ? messageTypeForMime(campaign.media.mimeType) : MessageType.TEXT;
    if (!text && !campaign.media) return skip('mensagem vazia', 500);

    const conversationId = await this.conversationFor(numberId, jid, contact);
    const message = await prisma.message.create({
      data: {
        conversationId,
        numberId,
        waMessageId: `pending:${randomUUID()}`,
        fromMe: true,
        source: MessageSource.CAMPAIGN,
        type,
        status: MessageStatus.PENDING,
        text: text || null,
        timestamp: now,
        campaignRecipientId: recipient.id,
        // Cada mensagem tem seu registro de mídia, apontando para o mesmo arquivo da campanha.
        media: campaign.media?.storageKey
          ? {
              create: {
                status: MediaStatus.STORED,
                storageKey: campaign.media.storageKey,
                mimeType: campaign.media.mimeType,
                fileName: campaign.media.fileName,
                size: campaign.media.size,
                sha256: campaign.media.sha256,
              },
            }
          : undefined,
      },
    });
    await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { renderedText: text } });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: now, lastMessageFromMe: true, lastMessagePreview: [MEDIA_PREVIEW_LABEL[type], text].filter(Boolean).join(': ').replace(/\s+/g, ' ').slice(0, 200) },
    });
    await publishEvent({ type: 'message.new', numberId, payload: { conversationId, messageId: message.id } });

    const ok = await sendPendingMessage(this.sessions, message.id, { simulateTyping: campaign.simulateTyping, sleep: this.sleep });

    let outcome: TickOutcome;
    if (ok) {
      await prisma.campaignRecipient.updateMany({ where: { id: recipient.id, status: RecipientStatus.SENDING }, data: { status: RecipientStatus.SENT } });
      await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { sentAt: this.now() } });
      await bumpDailyStat(numberId, 'campaignSent');
      await prisma.waNumber.update({ where: { id: numberId }, data: { consecutiveFailures: 0, warmupStartedAt: number.warmupStartedAt ?? now } });
      outcome = 'sent';
    } else {
      const failed = await prisma.message.findUnique({ where: { id: message.id }, select: { error: true } });
      await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: RecipientStatus.FAILED, error: failed?.error ?? 'Falha no envio' } });
      const updated = await prisma.waNumber.update({ where: { id: numberId }, data: { consecutiveFailures: { increment: 1 } } });
      if (updated.consecutiveFailures >= antiBan.maxConsecutiveFailures) {
        await this.suspect(numberId, `Disparos pausados: ${updated.consecutiveFailures} falhas de envio seguidas.`);
      }
      outcome = 'failed';
    }

    // Ritmo: pausa longa a cada N envios do dia; nos demais, intervalo aleatório.
    const count = sentToday + (ok ? 1 : 0);
    const longPause = ok && campaign.longPauseEvery > 0 && count % campaign.longPauseEvery === 0;
    const delayS = longPause
      ? randomBetween(campaign.longPauseMinS, campaign.longPauseMaxS, this.random)
      : randomBetween(campaign.minDelayS, campaign.maxDelayS, this.random);
    await this.defer(numberId, delayS * 1000);
    await this.afterRecipient(campaign.id);
    return outcome;
  }

  /** Tarefas periódicas: iniciar agendadas, limpar envios travados, medir qualidade, encerrar campanhas. */
  async maintain(): Promise<void> {
    const now = this.now();

    const due = await prisma.campaign.findMany({
      where: { status: CampaignStatus.SCHEDULED, OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
      select: { id: true },
    });
    // jobId fixo: a mesma campanha não é iniciada duas vezes.
    for (const c of due) await campaignQueue.add('start', { kind: 'start', campaignId: c.id }, { jobId: `start-${c.id}` });

    // Envio interrompido no meio (worker caiu): marca como falha em vez de reenviar, para não duplicar.
    const stale = await prisma.campaignRecipient.findMany({
      where: { status: RecipientStatus.SENDING, claimedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
      select: { id: true, campaignId: true },
    });
    if (stale.length) {
      await prisma.campaignRecipient.updateMany({
        where: { id: { in: stale.map((s) => s.id) }, status: RecipientStatus.SENDING },
        data: { status: RecipientStatus.FAILED, error: 'Envio interrompido; confira na conversa se a mensagem saiu' },
      });
    }

    await this.checkQuality(now);

    const running = await prisma.campaign.findMany({ where: { status: CampaignStatus.RUNNING }, select: { id: true } });
    for (const c of running) await this.completeIfDone(c.id);
  }

  /** Queda de qualidade: poucas das últimas mensagens de campanha do número chegaram ao destino. */
  private async checkQuality(now: Date): Promise<void> {
    const antiBan = await getSetting('antiBan');
    const numbers = await prisma.waNumber.findMany({
      where: { deletedAt: null, status: NumberStatus.CONNECTED, campaignEnabled: true },
      select: { id: true, resumedAt: true },
    });
    for (const n of numbers) {
      // Só mensagens com ao menos 30 min (tempo para o recibo chegar) e das últimas 24 h.
      const from = new Date(Math.max(now.getTime() - 86_400_000, n.resumedAt?.getTime() ?? 0));
      const sample = await prisma.campaignRecipient.findMany({
        where: { numberId: n.id, sentAt: { gte: from, lt: new Date(now.getTime() - 30 * 60_000) } },
        orderBy: { sentAt: 'desc' },
        take: antiBan.deliverySample,
        select: { deliveredAt: true },
      });
      if (sample.length < antiBan.deliverySample) continue;
      const rate = sample.filter((s) => s.deliveredAt).length / sample.length;
      if (rate < antiBan.minDeliveryRate) {
        await this.suspect(n.id, `Disparos pausados: só ${Math.round(rate * 100)}% das últimas ${sample.length} mensagens foram entregues.`);
      }
    }
  }

  /** Pausa automática: o número segue conectado para atender, mas não dispara até um gestor liberar. */
  private async suspect(numberId: string, reason: string): Promise<void> {
    const { count } = await prisma.waNumber.updateMany({
      where: { id: numberId, status: NumberStatus.CONNECTED },
      data: { status: NumberStatus.SUSPECT, pauseReason: reason, statusReason: reason },
    });
    if (!count) return;
    logger.warn({ numberId, reason }, 'número pausado automaticamente');
    const number = await prisma.waNumber.findUnique({ where: { id: numberId }, select: { phone: true } });
    await publishEvent({ type: 'number.status', numberId, payload: { status: NumberStatus.SUSPECT, phone: number?.phone, reason } });
    await audit({ action: 'number.auto_paused', entity: 'WaNumber', entityId: numberId, meta: { reason } });
  }

  private async defer(numberId: string, ms: number): Promise<void> {
    await prisma.waNumber.updateMany({ where: { id: numberId }, data: { nextSendAt: new Date(this.now().getTime() + ms) } });
  }

  private async afterRecipient(campaignId: string): Promise<void> {
    await this.completeIfDone(campaignId);
    await publishEvent({ type: 'campaign.updated', payload: { campaignId } });
  }

  /** Sem ninguém na fila nem em envio, a campanha em andamento é concluída. */
  private async completeIfDone(campaignId: string): Promise<void> {
    const pending = await prisma.campaignRecipient.count({ where: { campaignId, status: { in: [RecipientStatus.QUEUED, RecipientStatus.SENDING] } } });
    if (pending) return;
    const { count } = await prisma.campaign.updateMany({ where: { id: campaignId, status: CampaignStatus.RUNNING }, data: { status: CampaignStatus.COMPLETED, finishedAt: this.now() } });
    if (count) {
      logger.info({ campaignId }, 'campanha concluída');
      await publishEvent({ type: 'campaign.updated', payload: { campaignId } });
    }
  }

  private async conversationFor(numberId: string, jid: string, contact: { id: string; name: string | null; pushName: string | null }): Promise<string> {
    const where: Prisma.ConversationWhereInput = { numberId, OR: [{ remoteJid: jid }, { altJid: jid }] };
    const existing = await prisma.conversation.findFirst({ where, select: { id: true, contactId: true } });
    if (existing) {
      if (!existing.contactId) await prisma.conversation.update({ where: { id: existing.id }, data: { contactId: contact.id } });
      return existing.id;
    }
    try {
      return (await prisma.conversation.create({ data: { numberId, remoteJid: jid, contactId: contact.id, title: contact.name ?? contact.pushName }, select: { id: true } })).id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return (await prisma.conversation.findFirstOrThrow({ where, select: { id: true } })).id;
    }
  }
}
