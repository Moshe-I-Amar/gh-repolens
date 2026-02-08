import amqp, { Channel, Connection } from 'amqplib';
import { createLogger } from '@repolens/shared-utils';

let connection: Connection | undefined;
let channel: Channel | undefined;

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const defaultLogger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

/** Creates and caches a RabbitMQ channel using the Promise-based API. */
export const getRabbitChannel = async (
  rabbitUrl: string,
  logger: LoggerLike = defaultLogger,
): Promise<Channel> => {
  if (channel) return channel;

  logger.info({ rabbitUrl }, 'Connecting to RabbitMQ...');
  const activeConnection = await amqp.connect(rabbitUrl);
  const activeChannel = await activeConnection.createChannel();
  connection = activeConnection;
  channel = activeChannel;

  activeConnection.on('close', () => {
    logger.warn('RabbitMQ connection closed');
    connection = undefined;
    channel = undefined;
  });

  activeConnection.on('error', (err) => {
    logger.error({ err }, 'RabbitMQ connection error');
  });

  return activeChannel;
};

export const closeRabbit = async (): Promise<void> => {
  if (channel) {
    try {
      await channel.close();
    } catch {
    } finally {
      channel = undefined;
    }
  }

  if (connection) {
    try {
      await connection.close();
    } catch {
    } finally {
      connection = undefined;
    }
  }
};
