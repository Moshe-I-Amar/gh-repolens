import amqp, { Channel, Connection } from 'amqplib';
import { logger } from '@repolens/shared-utils';

let connection: Connection | undefined;
let channel: Channel | undefined;

/** Creates and caches a RabbitMQ channel using the Promise-based API. */
/** Creates and caches a RabbitMQ channel using the Promise-based API. */
export const getRabbitChannel = async (rabbitUrl: string): Promise<Channel> => {
  if (channel) return channel;

  logger.info({ rabbitUrl }, 'Connecting to RabbitMQ...');
  connection = await amqp.connect(rabbitUrl);
  channel = await connection.createChannel();

  connection.on('close', () => {
    logger.warn('RabbitMQ connection closed');
    connection = undefined;
    channel = undefined;
  });

  connection.on('error', (err) => {
    logger.error({ err }, 'RabbitMQ connection error');
  });

  return channel;
};

export const closeRabbit = async (): Promise<void> => {
  if (channel) {
    try {
      await channel.close();
    } catch {
      // ignore
    } finally {
      channel = undefined;
    }
  }

  if (connection) {
    try {
      await connection.close();
    } catch {
      // ignore
    } finally {
      connection = undefined;
    }
  }
};
