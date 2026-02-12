import { ConfirmChannel } from 'amqplib';

import { createLogger } from '@repolens/shared-utils';

import { JOBS_DLX, JOBS_EXCHANGE, JOBS_EXCHANGE_TYPE } from './constants';

const defaultLogger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'intake-service',
});

const getPayloadSummary = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  return {
    jobId: record.jobId,
    repoUrl: record.repoUrl,
    localPath: record.localPath,
  };
};

export const setupExchange = async (channel: ConfirmChannel) => {
  await channel.assertExchange(JOBS_EXCHANGE, JOBS_EXCHANGE_TYPE, { durable: true });
  await channel.assertExchange(JOBS_DLX, 'fanout', { durable: true });
};

export const publishMessage = async (
  channel: ConfirmChannel,
  routingKey: string,
  payload: unknown,
  logger = defaultLogger,
) => {
  await setupExchange(channel);
  const body = Buffer.from(JSON.stringify(payload));
  const published = channel.publish(JOBS_EXCHANGE, routingKey, body, {
    contentType: 'application/json',
    persistent: true,
  });

  if (!published) {
    logger.error({ routingKey }, 'RabbitMQ publish returned false');
    throw new Error('RABBITMQ_PUBLISH_BUFFER_FULL');
  }
  await channel.waitForConfirms();
  logger.info({ routingKey, payload: getPayloadSummary(payload) }, 'RabbitMQ message published');
};
