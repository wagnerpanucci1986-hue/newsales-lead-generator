import { Worker } from 'bullmq';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { QUEUE_SESSION, type SessionJob } from '../lib/queues.js';
import { bullConnection } from '../lib/redis.js';
import type { SessionManager } from '../whatsapp/session-manager.js';

/** Comandos de sessão vindos do painel (conectar, desconectar, sair, remover). */
export function createSessionWorker(sessions: SessionManager): Worker<SessionJob> {
  const worker = new Worker<SessionJob>(
    QUEUE_SESSION,
    async (job) => {
      const { action, numberId } = job.data;
      logger.info({ action, numberId }, 'comando de sessão');
      switch (action) {
        case 'connect':
          return sessions.connect(numberId);
        case 'disconnect':
          return sessions.disconnect(numberId);
        case 'logout':
          return sessions.logout(numberId);
        case 'remove':
          // Desvincula o aparelho e libera o telefone para um novo cadastro.
          await sessions.logout(numberId);
          await prisma.waNumber.updateMany({ where: { id: numberId }, data: { phone: null, jid: null, lid: null } });
          return;
      }
    },
    { connection: bullConnection(), concurrency: 4 },
  );
  worker.on('failed', (job, err) => logger.error({ err, job: job?.data }, 'comando de sessão falhou'));
  return worker;
}
