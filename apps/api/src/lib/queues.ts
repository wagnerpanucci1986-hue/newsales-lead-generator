import { Queue } from 'bullmq';
import { bullConnection } from './redis.js';

// Nomes e payloads das filas. A API só produz; o worker consome.
export const QUEUE_SESSION = 'session';
export const QUEUE_MEDIA = 'media';
export const QUEUE_OUTBOUND = 'outbound';
export const QUEUE_CONTACTS = 'contacts';
export const QUEUE_CAMPAIGN = 'campaign-control';

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

export type ContactsJob =
  | { kind: 'import'; importId: string }
  // Empresas da base de CNPJ → Contatos (usa um ImportJob para acompanhar).
  | { kind: 'cnpj-contacts'; importId: string }
  // Verifica no WhatsApp os contatos ainda não checados (de uma lista, de uma importação ou todos).
  | { kind: 'verify'; numberId: string; listId?: string; contactIds?: string[] };

export const contactsQueue = new Queue<ContactsJob>(QUEUE_CONTACTS, {
  connection,
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500, attempts: 1 },
});

/** Atualização da base de captação (download e filtragem dos arquivos da Receita). */
export const QUEUE_CNPJ = 'cnpj';
export type CnpjJob = { importId: string };
export const cnpjQueue = new Queue<CnpjJob>(QUEUE_CNPJ, {
  connection,
  defaultJobOptions: { removeOnComplete: 20, removeOnFail: 50, attempts: 1 },
});

/** Monta os destinatários e coloca a campanha em andamento. */
export type CampaignJob = { kind: 'start'; campaignId: string };

export const campaignQueue = new Queue<CampaignJob>(QUEUE_CAMPAIGN, {
  connection,
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500, attempts: 1 },
});

/** Fecha as conexões de todas as filas (encerramento da API e testes). */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([sessionQueue, mediaQueue, outboundQueue, contactsQueue, campaignQueue, cnpjQueue].map((q) => q.close()));
}
