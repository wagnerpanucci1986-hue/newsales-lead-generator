import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { HttpError } from './modules/auth/guard.js';
import { authRoutes } from './modules/auth/routes.js';
import { numberRoutes } from './modules/numbers/routes.js';
import { attachRealtime } from './realtime/socket.js';

async function main() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: 1024 * 1024 });

  await app.register(cors, { origin: env.WEB_URL, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', redis });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Dados inválidos', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'erro não tratado');
    return reply.code(500).send({ error: 'Erro interno' });
  });

  app.get('/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    return { ok: true };
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(numberRoutes, { prefix: '/api/numbers' });

  const io = attachRealtime(app.server);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'encerrando API');
    await io.close();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  logger.fatal({ err }, 'API falhou ao iniciar');
  process.exit(1);
});
