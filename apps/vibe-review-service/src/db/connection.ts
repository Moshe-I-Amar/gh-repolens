import mongoose, { Connection } from 'mongoose';

import { createLogger } from '@repolens/shared-utils';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

const defaultLogger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const maskMongoUri = (mongoUri: string) => mongoUri.replace(/\/\/.*@/, '//***@');

export const connectToMongo = async (
  mongoUri: string,
  logger: LoggerLike = defaultLogger,
): Promise<Connection> => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  mongoose.set('strictQuery', true);

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    logger.info({ mongoUri: maskMongoUri(mongoUri) }, 'MongoDB connected');
    return mongoose.connection;
  } catch (error) {
    logger.error({ error }, 'MongoDB connection failed');
    throw error;
  }
};
