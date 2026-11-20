import { MediaStatus } from '@prisma/client';
import { Worker } from 'bullmq';
import { downloadMediaMessage } from 'baileys';
import path from 'node:path';
import { sha256 } from '../lib/crypto.js';
import { publishEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { QUEUE_MEDIA, type MediaJob } from '../lib/queues.js';
import { bullConnection } from '../lib/redis.js';
import { storage } from '../lib/storage/index.js';
import { fromRaw } from '../whatsapp/parse.js';
import type { SessionManager } from '../whatsapp/session-manager.js';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
};

function extensionFor(mimeType: string, fileName: string | null): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  const fromName = fileName ? path.extname(fileName).slice(1).toLowerCase() : '';
  const ext = EXT_BY_MIME[base] ?? (fromName || base.split('/')[1] || 'bin');
  return ext.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
}

/** Baixa do WhatsApp, decifra e grava no storage as mídias das mensagens espelhadas. */
export function createMediaWorker(sessions: SessionManager): Worker<MediaJob> {
  const worker = new Worker<MediaJob>(
    QUEUE_MEDIA,
    async (job) => {
      const media = await prisma.media.findUnique({
        where: { id: job.data.mediaId },
        include: { message: { include: { conversation: { select: { remoteJid: true } } } } },
      });
      if (!media?.message || media.status === MediaStatus.STORED) return;
      const msg = media.message;
      if (!msg.raw) throw new Error('mensagem sem conteúdo bruto para baixar a mídia');

      const sock = sessions.getSocket(msg.numberId);
      const buffer = await downloadMediaMessage(
        { key: { id: msg.waMessageId, remoteJid: msg.conversation.remoteJid, fromMe: msg.fromMe }, message: fromRaw(msg.raw) },
        'buffer',
        {},
        // Com o número conectado, pede ao celular para reenviar mídia que já expirou no servidor.
        sock ? { logger: logger.child({ mod: 'baileys-media' }, { level: 'warn' }), reuploadRequest: sock.updateMediaMessage } : undefined,
      );

      const month = msg.timestamp.toISOString().slice(0, 7);
      const storageKey = `${msg.numberId}/${month}/${media.id}.${extensionFor(media.mimeType, media.fileName)}`;
      await storage.put(storageKey, buffer, media.mimeType);
      await prisma.media.update({
        where: { id: media.id },
        data: { status: MediaStatus.STORED, storageKey, size: buffer.length, sha256: sha256(buffer), error: null },
      });
      await publishEvent({
        type: 'media.ready',
        numberId: msg.numberId,
        payload: { conversationId: msg.conversationId, messageId: msg.id, status: MediaStatus.STORED },
      });
    },
    { connection: bullConnection(), concurrency: 3 },
  );

  // Só marca como falha depois da última tentativa.
  worker.on('failed', async (job, err) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    logger.warn({ err: err.message, mediaId: job.data.mediaId }, 'download de mídia falhou em definitivo');
    try {
      const media = await prisma.media.update({
        where: { id: job.data.mediaId },
        data: { status: MediaStatus.FAILED, error: err.message.slice(0, 300) },
        include: { message: { select: { id: true, numberId: true, conversationId: true } } },
      });
      if (media.message) {
        await publishEvent({
          type: 'media.ready',
          numberId: media.message.numberId,
          payload: { conversationId: media.message.conversationId, messageId: media.message.id, status: MediaStatus.FAILED },
        });
      }
    } catch (e) {
      logger.error({ err: e }, 'falha ao registrar erro de mídia');
    }
  });
  return worker;
}
