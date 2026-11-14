import { MessageStatus, MessageType } from '@prisma/client';
import { generateMessageIDV2, type AnyMessageContent, type WAMessage, type WAMessageKey } from 'baileys';
import type { Readable } from 'node:stream';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { bumpDailyStat } from '../lib/stats.js';
import { storage } from '../lib/storage/index.js';
import { parseMessage } from './parse.js';

/** Parte do socket Baileys usada no envio (permite testar com um socket falso). */
export interface SendSocket {
  user?: { id: string } | null;
  sendMessage(jid: string, content: AnyMessageContent, options?: { messageId?: string }): Promise<WAMessage | undefined>;
  readMessages(keys: WAMessageKey[]): Promise<void>;
}

export interface SocketProvider {
  getSocket(numberId: string): SendSocket | undefined;
}

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Uma fila por número: as mensagens de um mesmo número saem em ordem, uma por vez.
const chains = new Map<string, Promise<unknown>>();
export function withNumberLock<T>(numberId: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(numberId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  chains.set(numberId, run);
  void run.catch(() => undefined).finally(() => chains.get(numberId) === run && chains.delete(numberId));
  return run;
}

async function fail(messageId: string, numberId: string, conversationId: string, error: string): Promise<void> {
  await prisma.message.update({ where: { id: messageId }, data: { status: MessageStatus.FAILED, error: error.slice(0, 300) } });
  await bumpDailyStat(numberId, 'failed');
  await publishEvent({ type: 'message.status', numberId, payload: { conversationId, messageId, status: MessageStatus.FAILED } });
}

/**
 * Envia uma Message gravada como PENDING. O id do WhatsApp é gravado ANTES do
 * envio: assim o eco que volta pelo espelhamento encontra a linha existente em
 * vez de criar uma duplicata com origem "celular".
 */
export async function sendPendingMessage(sessions: SocketProvider, messageId: string): Promise<void> {
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { media: true, conversation: { select: { remoteJid: true } } },
  });
  if (!msg || msg.status !== MessageStatus.PENDING) return; // já processada

  const sock = sessions.getSocket(msg.numberId);
  if (!sock?.user) return fail(msg.id, msg.numberId, msg.conversationId, 'Número desconectado');

  await withNumberLock(msg.numberId, async () => {
    try {
      let content: AnyMessageContent;
      if (msg.type === MessageType.TEXT) {
        if (!msg.text) throw new Error('Mensagem vazia');
        content = { text: msg.text };
      } else {
        if (!msg.media?.storageKey) throw new Error('Arquivo do anexo não encontrado');
        const buffer = await toBuffer((await storage.get(msg.media.storageKey)).stream);
        const mimetype = msg.media.mimeType;
        const caption = msg.text ?? undefined;
        switch (msg.type) {
          case MessageType.IMAGE:
            content = { image: buffer, mimetype, caption };
            break;
          case MessageType.VIDEO:
            content = { video: buffer, mimetype, caption };
            break;
          case MessageType.AUDIO:
            content = { audio: buffer, mimetype, ptt: msg.media.isPtt };
            break;
          default:
            content = { document: buffer, mimetype, fileName: msg.media.fileName ?? 'arquivo', caption };
        }
      }

      const waMessageId = generateMessageIDV2(sock.user!.id);
      await prisma.message.update({ where: { id: msg.id }, data: { waMessageId } });

      const sent = await sock.sendMessage(msg.conversation.remoteJid, content, { messageId: waMessageId });

      // Guarda o conteúdo enviado: o WhatsApp pode pedi-lo de volta (getMessage) e o painel reaproveita.
      const parsed = sent ? parseMessage(sent) : null;
      await prisma.message.update({
        where: { id: msg.id },
        data: { raw: parsed?.kind === 'message' ? (parsed.raw as object) : undefined },
      });
      // O recibo do servidor pode ter chegado antes; só avança se ainda estiver pendente.
      const { count } = await prisma.message.updateMany({
        where: { id: msg.id, status: MessageStatus.PENDING },
        data: { status: MessageStatus.SENT },
      });
      await bumpDailyStat(msg.numberId, 'sent');
      if (count) {
        await publishEvent({
          type: 'message.status',
          numberId: msg.numberId,
          payload: { conversationId: msg.conversationId, messageId: msg.id, status: MessageStatus.SENT },
        });
      }
    } catch (err) {
      logger.error({ err, messageId: msg.id }, 'falha no envio');
      await fail(msg.id, msg.numberId, msg.conversationId, err instanceof Error ? err.message : 'Falha no envio');
    }
  });
}

/** Envia ao contato os recibos de leitura das mensagens que o atendente abriu no painel. */
export async function sendReadReceipts(sessions: SocketProvider, conversationId: string): Promise<void> {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { numberId: true, remoteJid: true } });
  if (!conv) return;
  const unread = await prisma.message.findMany({
    where: { conversationId, fromMe: false, readAt: null },
    orderBy: { timestamp: 'desc' },
    take: 50,
    select: { id: true, waMessageId: true, participantJid: true },
  });
  if (!unread.length) return;

  const sock = sessions.getSocket(conv.numberId);
  if (sock?.user) {
    await sock
      .readMessages(unread.map((m) => ({ id: m.waMessageId, remoteJid: conv.remoteJid, fromMe: false, participant: m.participantJid ?? undefined })))
      .catch((err) => logger.warn({ err, conversationId }, 'falha ao enviar recibos de leitura'));
  }
  // Marca como lidas mesmo sem conexão, para não reenviar recibos antigos depois.
  await prisma.message.updateMany({ where: { conversationId, fromMe: false, readAt: null }, data: { readAt: new Date() } });
}
