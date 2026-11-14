import { Worker } from 'bullmq';
import { logger } from '../lib/logger.js';
import { QUEUE_OUTBOUND, type OutboundJob } from '../lib/queues.js';
import { bullConnection } from '../lib/redis.js';
import { sendPendingMessage, sendReadReceipts, type SocketProvider } from '../whatsapp/sender.js';

/** Envios avulsos do painel (texto e mídia) e recibos de leitura. */
export function createOutboundWorker(sessions: SocketProvider): Worker<OutboundJob> {
  const worker = new Worker<OutboundJob>(
    QUEUE_OUTBOUND,
    async (job) => {
      if (job.data.kind === 'send') return sendPendingMessage(sessions, job.data.messageId);
      return sendReadReceipts(sessions, job.data.conversationId);
    },
    // A ordem por número é garantida dentro do sender; aqui números diferentes andam em paralelo.
    { connection: bullConnection(), concurrency: 10 },
  );
  worker.on('failed', (job, err) => logger.error({ err, job: job?.data }, 'job de envio falhou'));
  return worker;
}
