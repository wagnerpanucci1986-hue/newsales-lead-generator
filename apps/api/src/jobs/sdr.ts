import { Worker } from 'bullmq';
import { logger } from '../lib/logger.js';
import { QUEUE_SDR, type SdrJob } from '../lib/queues.js';
import { bullConnection } from '../lib/redis.js';
import { runSdrJob } from '../sdr/agent.js';
import type { SocketProvider } from '../whatsapp/sender.js';

/** Respostas, follow-ups e lembretes da IA do SDR. Poucas em paralelo: cada uma chama a API e digita. */
export function createSdrWorker(sessions: SocketProvider): Worker<SdrJob> {
  const worker = new Worker<SdrJob>(QUEUE_SDR, async (job) => runSdrJob(sessions, job.data), { connection: bullConnection(), concurrency: 3, lockDuration: 5 * 60_000 });
  worker.on('failed', (job, err) => logger.error({ err, job: job?.data }, 'job da IA do SDR falhou'));
  return worker;
}
