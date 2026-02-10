import 'dotenv/config';
import { createLogger } from '@repolens/shared-utils';

import { connectToMongo } from './db/connection';
import { JobModel } from './models/Job';
import { startRabbitChannel } from './queue/connection';
import { startJobCreatedConsumer } from './queue/consumer';
import { processJobCreatedMessage } from './worker/processJobCreatedMessage';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'repo-fetcher-service',
});

const start = async () => {
  const mongoUri = process.env.MONGODB_URI ?? '';
  const rabbitUrl = process.env.RABBITMQ_URL ?? '';

  if (!mongoUri || !rabbitUrl) {
    throw new Error('Missing required environment variables');
  }

  await connectToMongo(mongoUri, logger);
  await JobModel.init();

  const maxRetries = Number(process.env.MAX_RETRIES ?? 3);
  const retryTtlMs = Number(process.env.RETRY_TTL_MS ?? 10000);

  await startRabbitChannel(rabbitUrl, async (channel) => {
    await startJobCreatedConsumer(
      channel,
      async (payload) => {
        await processJobCreatedMessage(channel, payload as { jobId?: string });
      },
      logger,
      {
        maxRetries,
        retryTtlMs,
        onMaxRetries: async (payload) => {
          const jobId = (payload as { jobId?: string } | null)?.jobId;
          if (!jobId) {
            return;
          }
          await JobModel.findByIdAndUpdate(jobId, {
            status: 'FAILED',
            error: 'JOB_CREATED_MAX_RETRIES',
          });
        },
      },
    );
  }, logger);
};

start().catch((error) => {
  logger.error({ error }, 'Failed to start repo-fetcher service');
  process.exit(1);
});
