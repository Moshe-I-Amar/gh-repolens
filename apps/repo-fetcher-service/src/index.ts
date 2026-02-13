import 'dotenv/config';
import http from 'node:http';
import { createLogger } from '@repolens/shared-utils';

import { connectToMongo } from './db/connection';
import { JobModel } from './models/Job';
import { startRabbitChannel } from './queue/connection';
import { startJobCreatedConsumer } from './queue/consumer';
import { processJobCreatedMessage } from './worker/processJobCreatedMessage';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'repo-fetcher-service',
});

const ALLOWED_MONGO_URIS = new Set([
  'mongodb://localhost:27017/repoLens',
  'mongodb://host.docker.internal:27017/repoLens',
  'mongodb://mongodb:27017/repoLens',
]);
const START_RETRY_DELAY_MS = Number(process.env.START_RETRY_DELAY_MS ?? 5000);
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 3002);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startHealthServer = () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!req.url || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'repo-fetcher-service',
          uptimeSec: Math.round(process.uptime()),
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });

  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.info({ healthPort: HEALTH_PORT }, 'Repo-fetcher health endpoint listening');
  });
};

const start = async () => {
  const mongoUri = process.env.MONGODB_URI ?? '';
  const rabbitUrl = process.env.RABBITMQ_URL ?? '';

  if (!mongoUri || !rabbitUrl) {
    throw new Error('Missing required environment variables');
  }
  if (!ALLOWED_MONGO_URIS.has(mongoUri)) {
    throw new Error('MONGODB_URI_MUST_TARGET_REPOLENS_DB');
  }

  logger.info(
    {
      nodeVersion: process.version,
      pid: process.pid,
      appVersion: process.env.APP_VERSION ?? null,
      gitSha: process.env.GIT_SHA ?? null,
    },
    'Starting repo-fetcher service',
  );

  await connectToMongo(mongoUri, logger);
  await JobModel.init();
  startHealthServer();

  const maxRetries = Number(process.env.MAX_RETRIES ?? 3);
  const retryTtlMs = Number(process.env.RETRY_TTL_MS ?? 10000);

  await startRabbitChannel(rabbitUrl, async (channel) => {
    await startJobCreatedConsumer(
      channel,
      async (payload) => {
        await processJobCreatedMessage(channel, payload as { jobId?: string });
      },
      logger,
      {
        maxRetries,
        retryTtlMs,
        onMaxRetries: async (payload) => {
          const jobId = (payload as { jobId?: string } | null)?.jobId;
          if (!jobId) {
            return;
          }
          await JobModel.findByIdAndUpdate(jobId, {
            status: 'FAILED',
            error: 'JOB_CREATED_MAX_RETRIES',
          });
        },
      },
    );
  }, logger);
};

const startWithRetry = async () => {
  for (;;) {
    try {
      await start();
      return;
    } catch (error) {
      logger.error(
        { error, retryDelayMs: START_RETRY_DELAY_MS },
        'Failed to start repo-fetcher service, retrying',
      );
      await sleep(START_RETRY_DELAY_MS);
    }
  }
};

void startWithRetry();
