import { Channel, ConsumeMessage } from 'amqplib';

import { createLogger } from '@repolens/shared-utils';

import { JOBS_DLX, JOBS_EXCHANGE, JOBS_EXCHANGE_TYPE, QUEUES } from './constants';

const defaultLogger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const getRetryCount = (message: ConsumeMessage): number => {
  const death = message.properties.headers?.['x-death'];
  if (!Array.isArray(death) || death.length === 0) {
    return 0;
  }

  const count = death[0]?.count;
  return typeof count === 'number' ? count : 0;
};

export const setupJobFetchedQueue = async (channel: Channel) => {
  await channel.assertExchange(JOBS_EXCHANGE, JOBS_EXCHANGE_TYPE, { durable: true });
  await channel.assertExchange(JOBS_DLX, 'fanout', { durable: true });

  await channel.assertQueue(`${QUEUES.vibeReview}.dlq`, { durable: true });
  await channel.bindQueue(`${QUEUES.vibeReview}.dlq`, JOBS_DLX, '');

  await channel.assertQueue(QUEUES.vibeReview, {
    durable: true,
    deadLetterExchange: JOBS_DLX,
  });
  await channel.bindQueue(QUEUES.vibeReview, JOBS_EXCHANGE, 'job.fetched');
};

// Main consumer loop handling ack/nack and DLQ routing.
export const startJobFetchedConsumer = async (
  channel: Channel,
  onMessage: (payload: unknown) => Promise<void>,
  logger = defaultLogger,
  maxRetries = 3,
) => {
  await setupJobFetchedQueue(channel);
  await channel.prefetch(1);

  await channel.consume(QUEUES.vibeReview, async (message) => {
    if (!message) {
      return;
    }

    try {
      const payload = JSON.parse(message.content.toString());
      await onMessage(payload);
      channel.ack(message);
    } catch (error) {
      const retryCount = getRetryCount(message);
      logger.error({ error, retryCount }, 'Failed to process job.fetched message');

      if (retryCount >= maxRetries) {
        channel.nack(message, false, false);
        return;
      }

      channel.nack(message, false, true);
    }
  });
};
