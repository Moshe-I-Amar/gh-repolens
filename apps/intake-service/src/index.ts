import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { createLogger } from '@repolens/shared-utils';

import { connectToMongo } from './db/connection';
import { getRabbitChannel } from './queue/connection';
import { correlationIdMiddleware } from './middleware/correlationId';
import { errorHandler } from './middleware/errorHandler';
import { healthHandler } from './routes/health';
import { jobsRouter } from './routes/jobs';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'intake-service',
});

const ALLOWED_MONGO_URIS = new Set([
  'mongodb://localhost:27017/repoLens',
  'mongodb://host.docker.internal:27017/repoLens',
  'mongodb://mongodb:27017/repoLens',
]);
const START_RETRY_DELAY_MS = Number(process.env.START_RETRY_DELAY_MS ?? 5000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const start = async () => {
  const mongoUri = process.env.MONGODB_URI ?? '';
  const rabbitUrl = process.env.RABBITMQ_URL ?? '';
  const port = Number(process.env.PORT ?? 3001);

  if (!mongoUri || !rabbitUrl) {
    throw new Error('Missing required environment variables');
  }
  if (!ALLOWED_MONGO_URIS.has(mongoUri)) {
    throw new Error('MONGODB_URI_MUST_TARGET_REPOLENS_DB');
  }

  await connectToMongo(mongoUri, logger);
  const getChannel = () => getRabbitChannel(rabbitUrl, logger);

  const app = express();
  app.locals.getChannel = getChannel;

  app.use(helmet());
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-correlation-id',
    );
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use(correlationIdMiddleware);
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 60,
    }),
  );

  app.get('/health', healthHandler);
  app.use('/jobs', jobsRouter);
  app.use(errorHandler);

  app.listen(port, () => {
    logger.info({ port }, 'Intake service listening');
  });
};

const startWithRetry = async () => {
  for (;;) {
    try {
      await start();
      return;
    } catch (error) {
      logger.error(
        { error, retryDelayMs: START_RETRY_DELAY_MS },
        'Failed to start intake service, retrying',
      );
      await sleep(START_RETRY_DELAY_MS);
    }
  }
};

void startWithRetry();
