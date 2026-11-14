import { Worker } from 'bullmq';
import { startCampaign } from '../campaigns/audience.js';
import { logger } from '../lib/logger.js';
import { QUEUE_CAMPAIGN, type CampaignJob } from '../lib/queues.js';
import { bullConnection } from '../lib/redis.js';

/** Monta os destinatários de uma campanha e a coloca em andamento. */
export function createCampaignWorker(): Worker<CampaignJob> {
  const worker = new Worker<CampaignJob>(QUEUE_CAMPAIGN, async (job) => startCampaign(job.data.campaignId), {
    connection: bullConnection(),
    concurrency: 1,
    lockDuration: 300_000, // públicos grandes levam alguns minutos
  });
  worker.on('failed', (job, err) => logger.error({ err, campaignId: job?.data.campaignId }, 'falha ao iniciar campanha'));
  return worker;
}
