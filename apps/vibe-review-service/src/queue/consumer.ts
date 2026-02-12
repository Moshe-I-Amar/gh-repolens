import { ConfirmChannel, ConsumeMessage } from 'amqplib';

import { createLogger, logJobEvent } from '@repolens/shared-utils';

import {
  JOBS_DLX,
  JOBS_EXCHANGE,
  JOBS_EXCHANGE_TYPE,
  JOBS_RETRY_EXCHANGE,
  QUEUES,
  ROUTING_KEYS,
} from './constants';

const defaultLogger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'vibe-review-service',
});

const getDeathCount = (message: ConsumeMessage, queueName: string): number => {
  const death = message.properties.headers?.['x-death'];
  if (!Array.isArray(death) || death.length === 0) {
    return 0;
  }

  const entry = death.find((item) => item?.queue === queueName);
  const count = entry?.count;
  return typeof count === 'number' ? count : 0;
};

export const setupJobFetchedQueue = async (channel: ConfirmChannel, retryTtlMs: number) => {
  await channel.assertExchange(JOBS_EXCHANGE, JOBS_EXCHANGE_TYPE, { durable: true });
  await channel.assertExchange(JOBS_RETRY_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(JOBS_DLX, 'fanout', { durable: true });

  await channel.assertQueue(`${QUEUES.vibeReview}.dlq`, { durable: true });
  await channel.bindQueue(`${QUEUES.vibeReview}.dlq`, JOBS_DLX, '');

  await channel.assertQueue(QUEUES.vibeReviewRetry, {
    durable: true,
    messageTtl: retryTtlMs,
    deadLetterExchange: JOBS_EXCHANGE,
    deadLetterRoutingKey: ROUTING_KEYS.jobFetched,
  });
  await channel.bindQueue(
    QUEUES.vibeReviewRetry,
    JOBS_RETRY_EXCHANGE,
    ROUTING_KEYS.jobFetchedRetry,
  );

  await channel.assertQueue(QUEUES.vibeReview, {
    durable: true,
    deadLetterExchange: JOBS_RETRY_EXCHANGE,
    deadLetterRoutingKey: ROUTING_KEYS.jobFetchedRetry,
  });
  await channel.bindQueue(QUEUES.vibeReview, JOBS_EXCHANGE, 'job.fetched');
};

const publishToDlq = async (channel: ConfirmChannel, message: ConsumeMessage, logger = defaultLogger) => {
  const published = channel.publish(JOBS_DLX, '', message.content, {
    contentType: message.properties.contentType ?? 'application/json',
    persistent: true,
    headers: {
      ...(message.properties.headers ?? {}),
      'x-final-dlq': true,
    },
  });

  if (!published) {
    logger.error('DLQ publish returned false');
    throw new Error('RABBITMQ_DLX_PUBLISH_BUFFER_FULL');
  }
  await channel.waitForConfirms();
};

type ConsumerOptions = {
  maxRetries?: number;
  retryTtlMs?: number;
  onMaxRetries?: (payload: unknown) => Promise<void>;
};

// Main consumer loop handling ack/nack and DLQ routing.
export const startJobFetchedConsumer = async (
  channel: ConfirmChannel,
  onMessage: (payload: unknown) => Promise<void>,
  logger = defaultLogger,
  options: ConsumerOptions = {},
) => {
  const maxRetries = options.maxRetries ?? 3;
  const retryTtlMs = options.retryTtlMs ?? 10000;
  await setupJobFetchedQueue(channel, retryTtlMs);
  await channel.prefetch(1);

  await channel.consume(QUEUES.vibeReview, async (message) => {
    if (!message) {
      return;
    }

    try {
      const payload = JSON.parse(message.content.toString());
      const jobId = (payload as { jobId?: string } | null)?.jobId;
      if (jobId) {
        logJobEvent(logger, {
          jobId,
          stage: 'FETCHED',
          message: 'Received job.fetched message',
          fields: { routingKey: ROUTING_KEYS.jobFetched },
        });
      }
      await onMessage(payload);
      channel.ack(message);
    } catch (error) {
      const retryCount = getDeathCount(message, QUEUES.vibeReview);
      logger.error({ error, retryCount }, 'Failed to process job.fetched message');

      if (retryCount >= maxRetries) {
        const payload = (() => {
          try {
            return JSON.parse(message.content.toString());
          } catch {
            return null;
          }
        })();
        if (options.onMaxRetries) {
          await options.onMaxRetries(payload);
        }
        await publishToDlq(channel, message, logger);
        channel.ack(message);
        logger.error({ retryCount, maxRetries }, 'Max retries exceeded, routed to DLQ');
        return;
      }

      logger.warn(
        { retryCount, maxRetries, retryTtlMs },
        'Retrying job.fetched message via retry queue',
      );
      channel.nack(message, false, false);
    }
  });
};
