import { ConfirmChannel, connect } from 'amqplib';
import { createLogger } from '@repolens/shared-utils';

type ConnectionModel = Awaited<ReturnType<typeof connect>>;

let channel: ConfirmChannel | undefined;
let connectionModel: ConnectionModel | undefined;
let reconnecting: Promise<ConfirmChannel> | null = null;

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const defaultLogger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'intake-service',
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const maskRabbitUrl = (rabbitUrl: string) =>
  rabbitUrl.replace(/(amqps?:\/\/)([^@]+)@/i, '$1***@');

const connectOnce = async (rabbitUrl: string, logger: LoggerLike): Promise<ConfirmChannel> => {
  logger.info({ rabbitUrl: maskRabbitUrl(rabbitUrl) }, 'Connecting to RabbitMQ...');
  const activeConnection = await connect(rabbitUrl);
  const activeChannel = await activeConnection.createConfirmChannel();
  logger.info({ rabbitUrl: maskRabbitUrl(rabbitUrl) }, 'RabbitMQ connected');
  connectionModel = activeConnection;
  channel = activeChannel;

  const triggerReconnect = (reason: string, error?: unknown) => {
    logger.warn({ reason, error }, 'RabbitMQ disconnected, scheduling reconnect');
    channel = undefined;
    connectionModel = undefined;
    void reconnectWithBackoff(rabbitUrl, logger);
  };

  activeConnection.on('close', () => triggerReconnect('connection.close'));
  activeConnection.on('error', (err) => triggerReconnect('connection.error', err));
  activeChannel.on('close', () => triggerReconnect('channel.close'));
  activeChannel.on('error', (err) => triggerReconnect('channel.error', err));

  return activeChannel;
};

const reconnectWithBackoff = async (rabbitUrl: string, logger: LoggerLike) => {
  if (reconnecting) {
    return reconnecting;
  }

  reconnecting = (async () => {
    let attempt = 0;
    while (!channel) {
      attempt += 1;
      const delay = Math.min(1000 * 2 ** attempt, 10000);
      try {
        await sleep(delay);
        await connectOnce(rabbitUrl, logger);
        logger.info({ attempt }, 'RabbitMQ reconnected');
      } catch (error) {
        logger.error({ attempt, error }, 'RabbitMQ reconnect attempt failed');
      }
    }
    reconnecting = null;
    return channel;
  })();

  return reconnecting;
};

/** Creates and caches a RabbitMQ channel using the Promise-based API. */
export const getRabbitChannel = async (
  rabbitUrl: string,
  logger: LoggerLike = defaultLogger,
): Promise<ConfirmChannel> => {
  if (channel) {
    return channel;
  }

  if (reconnecting) {
    return reconnecting;
  }

  return connectOnce(rabbitUrl, logger);
};
