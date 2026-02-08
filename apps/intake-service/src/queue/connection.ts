import amqp, { Channel, Connection } from 'amqplib';

import { createLogger } from '@repolens/shared-utils';

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const defaultLogger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

let connection: Connection | null = null;
let channel: Channel | null = null;
let channelPromise: Promise<Channel> | null = null;

/** Creates and caches a RabbitMQ channel using the Promise-based API. */
export const getRabbitChannel = async (
  url: string,
  logger: LoggerLike = defaultLogger,
): Promise<Channel> => {
  if (channel) return channel;
  if (channelPromise) return channelPromise;

  channelPromise = (async () => {
    try {
      connection = await amqp.connect(url);
      channel = await connection.createChannel();

      connection.on('close', () => {
        logger.warn({}, 'RabbitMQ connection closed');
        connection = null;
        channel = null;
        channelPromise = null;
      });

      connection.on('error', (err) => {
        logger.error({ err }, 'RabbitMQ connection error');
      });

      return channel;
    } catch (error) {
      connection = null;
      channel = null;
      channelPromise = null;
      throw error;
    }
  })();

  return channelPromise;
};

export const closeRabbit = async (): Promise<void> => {
  try {
    if (channel) {
      await channel.close();
    }
  } catch {
  } finally {
    channel = null;
    channelPromise = null;
  }

  try {
    if (connection) {
      await connection.close();
    }
  } catch {
  } finally {
    connection = null;
  }
};
