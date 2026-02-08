import amqp, { Channel, Connection } from 'amqplib';

import { createLogger } from '@repolens/shared-utils';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const defaultLogger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const connectWithRetry = async (
  url: string,
  logger: LoggerLike = defaultLogger,
  maxAttempts = 10,
): Promise<Connection> => {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const connection = await amqp.connect(url);
      logger.info({ attempt }, 'RabbitMQ connected');
      return connection;
    } catch (error) {
      lastError = error;
      const delay = Math.min(1000 * 2 ** attempt, 10000);
      logger.error({ attempt, error }, 'RabbitMQ connection failed, retrying');
      await sleep(delay);
    }
  }

  throw lastError;
};

export const createChannel = async (connection: Connection): Promise<Channel> => {
  return connection.createChannel();
};
