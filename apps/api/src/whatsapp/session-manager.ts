import { NumberStatus } from '@prisma/client';
import { Browsers, DisconnectReason, makeCacheableSignalKeyStore, makeWASocket, type ConnectionState, type WASocket } from 'baileys';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { publishEvent, qrCacheKey } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { mediaQueue } from '../lib/queues.js';
import { redis } from '../lib/redis.js';
import { clearAuthState, usePostgresAuthState } from './auth-state.js';
import { isMirroredJid, normalizeJid, phoneFromJid } from './jid.js';
import { Mirror } from './mirror.js';
import { fromRaw } from './parse.js';

const MAX_QR_ATTEMPTS = 5; // QR Codes gerados antes de desistir do pareamento
const MAX_BACKOFF_MS = 60_000;
const BOOT_STAGGER_MS = 3_000; // intervalo entre conexões no boot

interface Session {
  numberId: string;
  sock: WASocket;
  mirror: Mirror;
  qrAttempts: number;
  /** true quando o fechamento foi pedido por nós (desconectar, logout, remover) */
  closing: boolean;
}

/**
 * Dono de todas as sessões WhatsApp. Roda somente no worker: a mesma sessão
 * aberta em dois processos é derrubada pelo WhatsApp (conflito 440).
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly retries = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>();
  private readonly opening = new Set<string>();
  private shuttingDown = false;

  /** Socket de um número conectado (para envio e download de mídia). */
  getSocket(numberId: string): WASocket | undefined {
    return this.sessions.get(numberId)?.sock;
  }

  /** Reconecta, no boot do worker, todo número que estava pareado. */
  async boot(): Promise<void> {
    // Nenhum socket existe ainda: o que estava "conectado" no banco é resto do processo anterior.
    await prisma.waNumber.updateMany({
      where: { status: { in: [NumberStatus.CONNECTED, NumberStatus.CONNECTING, NumberStatus.QR_PENDING] } },
      data: { status: NumberStatus.DISCONNECTED },
    });
    const numbers = await prisma.waNumber.findMany({
      where: { autoConnect: true, deletedAt: null, status: { not: NumberStatus.BANNED } },
      select: { id: true, nickname: true },
      orderBy: { createdAt: 'asc' },
    });
    logger.info({ count: numbers.length }, 'reconectando sessões salvas');
    for (const [i, n] of numbers.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, BOOT_STAGGER_MS));
      if (this.shuttingDown) return;
      await this.connect(n.id).catch((err) => logger.error({ err, numberId: n.id }, 'falha ao reconectar no boot'));
    }
  }

  /** Abre a sessão. Sem credenciais salvas, o WhatsApp responde com um QR Code. */
  async connect(numberId: string): Promise<void> {
    if (this.sessions.has(numberId) || this.opening.has(numberId)) return; // já conectando/conectado
    this.opening.add(numberId);
    try {
      await this.open(numberId);
    } finally {
      this.opening.delete(numberId);
    }
  }

  private async open(numberId: string): Promise<void> {
    const number = await prisma.waNumber.findFirst({ where: { id: numberId, deletedAt: null } });
    if (!number) throw new Error('número não encontrado');

    this.clearRetryTimer(numberId);
    const log = logger.child({ numberId, nickname: number.nickname });
    const { state, saveCreds } = await usePostgresAuthState(numberId);
    const baileysLog = logger.child({ numberId, mod: 'baileys' }, { level: 'warn' });

    // Status antes de criar o socket: daqui até registrar o handler de eventos não
    // pode haver await, senão um fechamento imediato (ex.: sem rede) passa despercebido.
    await this.setStatus(numberId, NumberStatus.CONNECTING);

    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLog) },
      logger: baileysLog,
      // Identificar-se como app desktop é o que libera o histórico completo.
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: env.SYNC_FULL_HISTORY,
      shouldSyncHistoryMessage: () => true,
      // Não marca o número como "online": o celular continua recebendo notificações.
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) => !isMirroredJid(jid),
      // O WhatsApp pede o conteúdo de volta quando o destinatário não conseguiu decifrar.
      getMessage: async (key) => {
        if (!key.id) return undefined;
        const row = await prisma.message.findUnique({
          where: { numberId_waMessageId: { numberId, waMessageId: key.id } },
          select: { raw: true },
        });
        return row?.raw ? fromRaw(row.raw) : undefined;
      },
    });

    const mirror = new Mirror({
      numberId,
      resolvePn: (lid) => sock.signalRepository.lidMapping.getPNForLID(lid),
      groupSubject: async (jid) => (await sock.groupMetadata(jid)).subject ?? null,
      enqueueMedia: async (mediaId) => {
        await mediaQueue.add('download', { mediaId }, { jobId: `media-${mediaId}` });
      },
    });

    const session: Session = { numberId, sock, mirror, qrAttempts: 0, closing: false };
    this.sessions.set(numberId, session);

    // Um handler por lote de eventos, em ordem. Eventos de um socket já substituído são ignorados.
    sock.ev.process(async (events) => {
      if (this.sessions.get(numberId) !== session) return;
      const safe = async (name: string, fn: () => unknown) => {
        try {
          await fn();
        } catch (err) {
          log.error({ err, event: name }, 'erro ao tratar evento do WhatsApp');
        }
      };

      if (events['creds.update']) await safe('creds.update', saveCreds);
      if (events['connection.update']) await safe('connection.update', () => this.onConnectionUpdate(session, events['connection.update']!));
      if (events['contacts.upsert']) await safe('contacts.upsert', () => mirror.onContacts(events['contacts.upsert']!));
      if (events['contacts.update']) await safe('contacts.update', () => mirror.onContacts(events['contacts.update']!));
      if (events['lid-mapping.update']) await safe('lid-mapping.update', () => mirror.onLidMapping(events['lid-mapping.update']!));
      if (events['messaging-history.set']) await safe('messaging-history.set', () => mirror.onHistory(events['messaging-history.set']!));
      if (events['messages.upsert']) await safe('messages.upsert', () => mirror.onUpsert(events['messages.upsert']!.messages));
      if (events['messages.update']) await safe('messages.update', () => mirror.onMessagesUpdate(events['messages.update']!));
      if (events['message-receipt.update']) await safe('message-receipt.update', () => mirror.onReceipts(events['message-receipt.update']!));
      if (events['chats.update']) await safe('chats.update', () => mirror.onChatsUpdate(events['chats.update']!));
      if (events['groups.update']) await safe('groups.update', () => mirror.onGroupsUpdate(events['groups.update']!));
    });
  }

  /** Fecha o socket mantendo as credenciais (dá para reconectar sem QR). */
  async disconnect(numberId: string): Promise<void> {
    this.clearRetryTimer(numberId);
    this.retries.delete(numberId);
    await prisma.waNumber.updateMany({ where: { id: numberId }, data: { autoConnect: false } });
    this.closeSocket(numberId);
    await this.setStatus(numberId, NumberStatus.DISCONNECTED, { reason: 'Desconectado pelo painel' });
  }

  /** Desvincula o aparelho no WhatsApp e apaga as credenciais: exige novo QR. */
  async logout(numberId: string): Promise<void> {
    this.clearRetryTimer(numberId);
    this.retries.delete(numberId);
    const session = this.sessions.get(numberId);
    if (session) {
      session.closing = true;
      await session.sock.logout().catch((err) => logger.warn({ err, numberId }, 'logout no WhatsApp falhou; limpando localmente'));
    }
    this.closeSocket(numberId);
    await clearAuthState(numberId);
    await prisma.waNumber.updateMany({ where: { id: numberId }, data: { autoConnect: false } });
    await this.setStatus(numberId, NumberStatus.DISCONNECTED, { reason: 'Sessão encerrada pelo painel' });
  }

  /** Encerra tudo sem alterar o banco: no próximo boot as sessões voltam sozinhas. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const id of [...this.retries.keys()]) this.clearRetryTimer(id);
    for (const id of [...this.sessions.keys()]) this.closeSocket(id);
  }

  // ───────────── internos ─────────────

  private closeSocket(numberId: string): void {
    const session = this.sessions.get(numberId);
    if (!session) return;
    session.closing = true;
    this.sessions.delete(numberId);
    try {
      session.sock.end(undefined);
    } catch (err) {
      logger.warn({ err, numberId }, 'erro ao fechar socket');
    }
  }

  private clearRetryTimer(numberId: string): void {
    const retry = this.retries.get(numberId);
    if (retry?.timer) clearTimeout(retry.timer);
    if (retry) retry.timer = undefined;
  }

  private async onConnectionUpdate(session: Session, update: Partial<ConnectionState>): Promise<void> {
    const { numberId, sock } = session;
    const log = logger.child({ numberId });

    if (update.qr) {
      session.qrAttempts++;
      if (session.qrAttempts > MAX_QR_ATTEMPTS) {
        log.info('QR Code não foi lido a tempo; encerrando tentativa de pareamento');
        this.closeSocket(numberId);
        await this.setStatus(numberId, NumberStatus.DISCONNECTED, { reason: 'QR Code expirou sem leitura' });
        return;
      }
      await redis.set(qrCacheKey(numberId), JSON.stringify({ qr: update.qr, attempt: session.qrAttempts, maxAttempts: MAX_QR_ATTEMPTS }), 'EX', 70);
      await this.setStatus(numberId, NumberStatus.QR_PENDING);
      await publishEvent({ type: 'number.qr', numberId, payload: { qr: update.qr, attempt: session.qrAttempts, maxAttempts: MAX_QR_ATTEMPTS } });
    }

    if (update.connection === 'open') {
      const jid = normalizeJid(sock.user?.id);
      const phone = phoneFromJid(jid);

      // O mesmo chip pareado em dois cadastros faria as sessões se derrubarem.
      if (phone) {
        const clash = await prisma.waNumber.findFirst({ where: { phone, id: { not: numberId }, deletedAt: null }, select: { nickname: true } });
        if (clash) {
          log.warn({ phone }, 'telefone já cadastrado em outro número; desfazendo pareamento');
          await this.logout(numberId);
          await this.setStatus(numberId, NumberStatus.DISCONNECTED, { reason: `Este telefone já está cadastrado como "${clash.nickname}"` });
          return;
        }
      }

      this.retries.delete(numberId);
      session.qrAttempts = 0;
      await redis.del(qrCacheKey(numberId));
      await prisma.waNumber.update({
        where: { id: numberId },
        data: { phone, jid, lid: normalizeJid(sock.user?.lid), autoConnect: true, lastConnectedAt: new Date(), lastDisconnectCode: null },
      });
      await this.setStatus(numberId, NumberStatus.CONNECTED);
      log.info({ phone }, 'número conectado');
    }

    if (update.connection === 'close') {
      const error = update.lastDisconnect?.error as { output?: { statusCode?: number }; message?: string } | undefined;
      const code = error?.output?.statusCode;
      const wasClosing = session.closing;
      if (this.sessions.get(numberId) === session) this.sessions.delete(numberId);
      await redis.del(qrCacheKey(numberId));
      if (wasClosing || this.shuttingDown) return; // fechamento pedido por nós: status já tratado

      await prisma.waNumber.updateMany({ where: { id: numberId }, data: { lastDisconnectedAt: new Date(), lastDisconnectCode: code ?? null } });
      log.warn({ code, message: error?.message }, 'conexão com o WhatsApp fechada');

      switch (code) {
        case DisconnectReason.loggedOut: // aparelho desvinculado pelo celular
        case DisconnectReason.badSession:
        case DisconnectReason.multideviceMismatch:
          await clearAuthState(numberId);
          await prisma.waNumber.updateMany({ where: { id: numberId }, data: { autoConnect: false } });
          await this.setStatus(numberId, NumberStatus.DISCONNECTED, {
            reason: code === DisconnectReason.loggedOut ? 'Aparelho desvinculado no celular. Leia o QR Code novamente.' : 'Sessão inválida. Leia o QR Code novamente.',
          });
          await audit({ action: 'number.session_lost', entity: 'WaNumber', entityId: numberId, meta: { code } });
          return;

        case DisconnectReason.forbidden: // conta banida ou restrita
          await prisma.waNumber.updateMany({ where: { id: numberId }, data: { autoConnect: false, campaignEnabled: false } });
          await this.setStatus(numberId, NumberStatus.BANNED, { reason: 'O WhatsApp recusou a conexão (conta banida ou restrita).' });
          await audit({ action: 'number.banned', entity: 'WaNumber', entityId: numberId, meta: { code } });
          return;

        case DisconnectReason.connectionReplaced: // sessão aberta em outro lugar: não disputar
          await this.setStatus(numberId, NumberStatus.DISCONNECTED, { reason: 'Sessão aberta em outro local. Reconecte manualmente.' });
          return;

        case DisconnectReason.restartRequired: // normal logo após ler o QR
          await this.reconnect(numberId, 0);
          return;

        default: {
          const retry = this.retries.get(numberId) ?? { attempts: 0 };
          retry.attempts++;
          this.retries.set(numberId, retry);
          const backoff = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(retry.attempts - 1, 5));
          await this.reconnect(numberId, backoff + Math.random() * 1_000);
        }
      }
    }
  }

  private async reconnect(numberId: string, delayMs: number): Promise<void> {
    await this.setStatus(numberId, NumberStatus.CONNECTING);
    const retry = this.retries.get(numberId) ?? { attempts: 0 };
    this.retries.set(numberId, retry);
    this.clearRetryTimer(numberId);
    retry.timer = setTimeout(() => {
      retry.timer = undefined;
      if (this.shuttingDown) return;
      this.connect(numberId).catch((err) => logger.error({ err, numberId }, 'falha ao reconectar'));
    }, delayMs);
  }

  private async setStatus(numberId: string, status: NumberStatus, opts: { reason?: string } = {}): Promise<void> {
    const updated = await prisma.waNumber.update({
      where: { id: numberId },
      data: { status, statusReason: opts.reason ?? null },
      select: { phone: true },
    });
    await publishEvent({ type: 'number.status', numberId, payload: { status, phone: updated.phone, reason: opts.reason ?? null } });
  }
}
