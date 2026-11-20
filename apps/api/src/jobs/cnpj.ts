import { Worker } from 'bullmq';
import { runCnpjImport } from '../cnpj/importer.js';
import { logger } from '../lib/logger.js';
import { QUEUE_CNPJ, type CnpjJob } from '../lib/queues.js';
import { bullConnection } from '../lib/redis.js';

/** Atualização da base de CNPJ: uma por vez, pode levar dezenas de minutos. */
export function createCnpjWorker(): Worker<CnpjJob> {
  const worker = new Worker<CnpjJob>(QUEUE_CNPJ, async (job) => runCnpjImport(job.data.importId), {
    connection: bullConnection(),
    concurrency: 1,
    lockDuration: 10 * 60_000,
  });
  worker.on('failed', (job, err) => logger.error({ err, importId: job?.data.importId }, 'job da base de CNPJ falhou'));
  return worker;
}
