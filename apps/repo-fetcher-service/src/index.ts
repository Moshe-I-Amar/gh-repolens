import 'dotenv/config';
import { createLogger } from '@repolens/shared-utils';

import { connectToMongo } from './db/connection';
import { JobModel } from './models/Job';
import { connectWithRetry, createChannel } from './queue/connection';
import { startJobCreatedConsumer } from './queue/consumer';
import { processJobCreatedMessage } from './worker/processJobCreatedMessage';

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const start = async () => {
  const mongoUri = process.env.MONGODB_URI ?? '';
  const rabbitUrl = process.env.RABBITMQ_URL ?? '';

  if (!mongoUri || !rabbitUrl) {
    throw new Error('Missing required environment variables');
  }

  await connectToMongo(mongoUri, logger);
  await JobModel.init();

  const connection = await connectWithRetry(rabbitUrl, logger);
  const channel = await createChannel(connection);

  await startJobCreatedConsumer(
    channel,
    async (payload) => {
      await processJobCreatedMessage(channel, payload as { jobId?: string });
    },
    logger,
  );
};

start().catch((error) => {
  logger.error({ error }, 'Failed to start repo-fetcher service');
  process.exit(1);
});
