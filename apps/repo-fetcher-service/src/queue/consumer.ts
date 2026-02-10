import { Channel, ConsumeMessage } from 'amqplib';

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
  service: 'repo-fetcher-service',
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

export const setupJobCreatedQueue = async (channel: Channel, retryTtlMs: number) => {
  await channel.assertExchange(JOBS_EXCHANGE, JOBS_EXCHANGE_TYPE, { durable: true });
  await channel.assertExchange(JOBS_RETRY_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(JOBS_DLX, 'fanout', { durable: true });

  await channel.assertQueue(`${QUEUES.repoFetcher}.dlq`, { durable: true });
  await channel.bindQueue(`${QUEUES.repoFetcher}.dlq`, JOBS_DLX, '');

  await channel.assertQueue(QUEUES.repoFetcherRetry, {
    durable: true,
    messageTtl: retryTtlMs,
    deadLetterExchange: JOBS_EXCHANGE,
    deadLetterRoutingKey: ROUTING_KEYS.jobCreated,
  });
  await channel.bindQueue(
    QUEUES.repoFetcherRetry,
    JOBS_RETRY_EXCHANGE,
    ROUTING_KEYS.jobCreatedRetry,
  );

  await channel.assertQueue(QUEUES.repoFetcher, {
    durable: true,
    deadLetterExchange: JOBS_RETRY_EXCHANGE,
    deadLetterRoutingKey: ROUTING_KEYS.jobCreatedRetry,
  });
  await channel.bindQueue(QUEUES.repoFetcher, JOBS_EXCHANGE, 'job.created');
};

const publishToDlq = async (channel: Channel, message: ConsumeMessage, logger = defaultLogger) => {
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
  }
};

type ConsumerOptions = {
  maxRetries?: number;
  retryTtlMs?: number;
  onMaxRetries?: (payload: unknown) => Promise<void>;
};

// Main consumer loop handling ack/nack and DLQ routing.
export const startJobCreatedConsumer = async (
  channel: Channel,
  onMessage: (payload: unknown) => Promise<void>,
  logger = defaultLogger,
  options: ConsumerOptions = {},
) => {
  const maxRetries = options.maxRetries ?? 3;
  const retryTtlMs = options.retryTtlMs ?? 10000;
  await setupJobCreatedQueue(channel, retryTtlMs);
  await channel.prefetch(1);

  await channel.consume(QUEUES.repoFetcher, async (message) => {
    if (!message) {
      return;
    }

    try {
      const payload = JSON.parse(message.content.toString());
      const jobId = (payload as { jobId?: string } | null)?.jobId;
      if (jobId) {
        logJobEvent(logger, {
          jobId,
          stage: 'QUEUED',
          message: 'Received job.created message',
          fields: { routingKey: ROUTING_KEYS.jobCreated },
        });
      }
      await onMessage(payload);
      channel.ack(message);
    } catch (error) {
      const retryCount = getDeathCount(message, QUEUES.repoFetcher);
      logger.error({ error, retryCount }, 'Failed to process job.created message');

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
        'Retrying job.created message via retry queue',
      );
      channel.nack(message, false, false);
    }
  });
};
