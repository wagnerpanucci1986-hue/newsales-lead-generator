import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { EVENTS_CHANNEL, type AppEvent } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { createRedis } from '../lib/redis.js';
import { accessibleNumberIds, userFromToken } from '../modules/auth/guard.js';

const ROOM_ALL = 'numbers:all';
const roomOf = (numberId: string) => `number:${numberId}`;

/**
 * Socket.IO: autentica pelo access token e coloca cada usuário apenas nas salas
 * dos números que ele pode ver. Os eventos chegam do worker pelo Redis.
 */
export function attachRealtime(httpServer: HttpServer): Server {
  const io = new Server(httpServer, { cors: { origin: env.WEB_URL, credentials: true } });

  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(socket.handshake.auth?.token);
      if (!user) return next(new Error('unauthorized'));
      const ids = await accessibleNumberIds(user);
      if (ids === null) await socket.join(ROOM_ALL);
      else await socket.join(ids.map(roomOf));
      next();
    } catch (err) {
      logger.error({ err }, 'erro na autenticação do socket');
      next(new Error('unauthorized'));
    }
  });

  const sub = createRedis();
  sub.subscribe(EVENTS_CHANNEL).catch((err) => logger.error({ err }, 'falha ao assinar canal de eventos'));
  sub.on('message', (_channel, raw) => {
    try {
      const event = JSON.parse(raw) as AppEvent;
      const rooms = event.numberId ? [ROOM_ALL, roomOf(event.numberId)] : [ROOM_ALL];
      io.to(rooms).emit(event.type, { numberId: event.numberId, ...event.payload });
    } catch (err) {
      logger.warn({ err }, 'evento inválido no canal');
    }
  });

  io.on('close', () => void sub.quit());
  return io;
}
