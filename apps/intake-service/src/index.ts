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

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const start = async () => {
  const mongoUri = process.env.MONGODB_URI ?? '';
  const rabbitUrl = process.env.RABBITMQ_URL ?? '';
  const port = Number(process.env.PORT ?? 3001);

  if (!mongoUri || !rabbitUrl) {
    throw new Error('Missing required environment variables');
  }

  await connectToMongo(mongoUri, logger);
  const channel = await getRabbitChannel(rabbitUrl, logger);

  const app = express();
  app.locals.channel = channel;

  app.use(helmet());
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

start().catch((error) => {
  logger.error({ error }, 'Failed to start intake service');
  process.exit(1);
});
