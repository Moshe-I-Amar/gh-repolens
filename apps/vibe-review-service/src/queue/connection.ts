import { Channel, connect } from 'amqplib';
import { createLogger } from '@repolens/shared-utils';

type ConnectionModel = Awaited<ReturnType<typeof connect>>;

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const defaultLogger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'vibe-review-service',
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const connectWithRetry = async (
  url: string,
  logger: LoggerLike = defaultLogger,
  maxAttempts = 10,
): Promise<ConnectionModel> => {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const connection = await connect(url);
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

export const createChannel = async (connection: ConnectionModel): Promise<Channel> => {
  return connection.createChannel();
};

type ChannelHandler = (channel: Channel) => Promise<void>;

export const startRabbitChannel = async (
  url: string,
  onChannel: ChannelHandler,
  logger: LoggerLike = defaultLogger,
) => {
  let reconnecting = false;

  const connectOnce = async () => {
    const connection = await connect(url);
    logger.info('RabbitMQ connected');
    const channel = await connection.createChannel();

    const triggerReconnect = async (reason: string, error?: unknown) => {
      if (reconnecting) {
        return;
      }
      reconnecting = true;
      logger.warn({ reason, error }, 'RabbitMQ disconnected, attempting reconnect');
      let attempt = 0;
      while (reconnecting) {
        attempt += 1;
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        try {
          await sleep(delay);
          await connectOnce();
          reconnecting = false;
          logger.info({ attempt }, 'RabbitMQ reconnected');
        } catch (err) {
          logger.error({ attempt, err }, 'RabbitMQ reconnect attempt failed');
        }
      }
    };

    connection.on('close', () => void triggerReconnect('connection.close'));
    connection.on('error', (err) => void triggerReconnect('connection.error', err));
    channel.on('close', () => void triggerReconnect('channel.close'));
    channel.on('error', (err) => void triggerReconnect('channel.error', err));

    await onChannel(channel);
  };

  await connectOnce();
};
