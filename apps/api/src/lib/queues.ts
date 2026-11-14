import { Queue } from 'bullmq';
import { bullConnection } from './redis.js';

// Nomes e payloads das filas. A API só produz; o worker consome.
export const QUEUE_SESSION = 'session';
export const QUEUE_MEDIA = 'media';
export const QUEUE_OUTBOUND = 'outbound';

export type SessionJob = { action: 'connect' | 'disconnect' | 'logout' | 'remove'; numberId: string };
export type MediaJob = { mediaId: string };
export type OutboundJob =
  | { kind: 'send'; messageId: string } // envia uma Message já gravada como PENDING
  | { kind: 'read'; conversationId: string }; // envia recibos de leitura ao contato

const connection = bullConnection();

export const sessionQueue = new Queue<SessionJob>(QUEUE_SESSION, {
  connection,
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500, attempts: 1 },
});

export const mediaQueue = new Queue<MediaJob>(QUEUE_MEDIA, {
  connection,
  defaultJobOptions: {
    removeOnComplete: 500,
    removeOnFail: 1000,
    attempts: 4,
    backoff: { type: 'exponential', delay: 15_000 },
  },
});

// Sem novas tentativas automáticas no envio: repetir poderia duplicar a mensagem para o cliente.
export const outboundQueue = new Queue<OutboundJob>(QUEUE_OUTBOUND, {
  connection,
  defaultJobOptions: { removeOnComplete: 500, removeOnFail: 1000, attempts: 1 },
});
