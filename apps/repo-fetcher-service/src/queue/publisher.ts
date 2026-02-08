import { Channel } from 'amqplib';

import { createLogger } from '@repolens/shared-utils';

import { JOBS_DLX, JOBS_EXCHANGE, JOBS_EXCHANGE_TYPE } from './constants';

const defaultLogger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

export const setupExchange = async (channel: Channel) => {
  await channel.assertExchange(JOBS_EXCHANGE, JOBS_EXCHANGE_TYPE, { durable: true });
  await channel.assertExchange(JOBS_DLX, 'fanout', { durable: true });
};

export const publishMessage = async (
  channel: Channel,
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
  }
};
