import { redis } from './redis.js';
import { logger } from './logger.js';

// Eventos de tempo real: o worker publica, a API assina e repassa via Socket.IO
// para a sala do número. Só dados que o painel precisa — nunca credenciais.
export const EVENTS_CHANNEL = 'events';

export type AppEvent =
  | { type: 'number.status'; numberId: string; payload: { status: string; phone?: string | null; reason?: string | null } }
  | { type: 'number.qr'; numberId: string; payload: { qr: string; attempt: number; maxAttempts: number } }
  | { type: 'message.new'; numberId: string; payload: { conversationId: string; messageId: string } }
  | { type: 'message.status'; numberId: string; payload: { conversationId: string; messageId: string; status: string } }
  | { type: 'conversation.updated'; numberId: string; payload: { conversationId: string } }
  | { type: 'media.ready'; numberId: string; payload: { conversationId: string; messageId: string; status: string } };

export async function publishEvent(event: AppEvent): Promise<void> {
  try {
    await redis.publish(EVENTS_CHANNEL, JSON.stringify(event));
  } catch (err) {
    // tempo real é melhor-esforço: o dado já está no banco
    logger.warn({ err, type: event.type }, 'falha ao publicar evento');
  }
}

export const qrCacheKey = (numberId: string) => `qr:${numberId}`;
