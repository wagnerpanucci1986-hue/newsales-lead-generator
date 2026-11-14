import { randomUUID } from 'node:crypto';
import { createMediaWorker } from './jobs/media.js';
import { createSessionWorker } from './jobs/session.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { SessionManager } from './whatsapp/session-manager.js';

// Trava de líder: garante um único worker dono das sessões WhatsApp. Um segundo
// worker fica em espera e assume se o primeiro cair (a trava expira em 30 s).
const LOCK_KEY = 'worker:leader';
const LOCK_TTL_MS = 30_000;
const instanceId = randomUUID();

const RENEW_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

async function acquireLeadership(): Promise<void> {
  let warned = false;
  for (;;) {
    const ok = await redis.set(LOCK_KEY, instanceId, 'PX', LOCK_TTL_MS, 'NX');
    if (ok) return;
    if (!warned) {
      logger.warn('já existe um worker ativo; aguardando em espera');
      warned = true;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function main() {
  await acquireLeadership();
  logger.info({ instanceId }, 'worker iniciado');

  const sessions = new SessionManager();
  const workers = [createSessionWorker(sessions), createMediaWorker(sessions)];

  let stopping = false;
  const shutdown = async (signal: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'encerrando worker');
    clearInterval(renew);
    await Promise.allSettled(workers.map((w) => w.close()));
    await sessions.shutdown();
    await redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, instanceId).catch(() => undefined);
    await prisma.$disconnect();
    process.exit(code);
  };

  const renew = setInterval(async () => {
    try {
      const ok = await redis.eval(RENEW_SCRIPT, 1, LOCK_KEY, instanceId, String(LOCK_TTL_MS));
      // Perdeu a trava (Redis reiniciou, pausa longa): sair para não haver dois donos de sessão.
      if (!ok) await shutdown('trava de líder perdida', 1);
    } catch (err) {
      logger.error({ err }, 'falha ao renovar a trava de líder');
    }
  }, LOCK_TTL_MS / 3);

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await sessions.boot();
}

// Erros soltos de bibliotecas não podem derrubar todas as sessões.
process.on('unhandledRejection', (err) => logger.error({ err }, 'promise rejeitada sem tratamento'));
process.on('uncaughtException', (err) => logger.error({ err }, 'exceção não capturada'));

main().catch((err) => {
  logger.fatal({ err }, 'worker falhou ao iniciar');
  process.exit(1);
});
