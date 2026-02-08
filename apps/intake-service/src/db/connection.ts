import mongoose, { Connection } from 'mongoose';

import { createLogger } from '@repolens/shared-utils';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const defaultLogger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const maskMongoUri = (mongoUri: string) => mongoUri.replace(/\/\/.*@/, '//***@');

// Connect once and reuse the shared mongoose connection.
export const connectToMongo = async (
  mongoUri: string,
  logger: LoggerLike = defaultLogger,
): Promise<Connection> => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  mongoose.set('strictQuery', true);

  try {
    const connectOptions = {
      serverSelectionTimeoutMS: 5000,
    } satisfies mongoose.ConnectOptions;
    await mongoose.connect(mongoUri, connectOptions);
    logger.info({ mongoUri: maskMongoUri(mongoUri) }, 'MongoDB connected');
    return mongoose.connection;
  } catch (error) {
    logger.error({ error }, 'MongoDB connection failed');
    throw error;
  }
};
