import { Router } from 'express';
import type { Request, Response } from 'express';

import { createLogger, isValidGithubRepoUrl, logJobEvent } from '@repolens/shared-utils';
import { jobStatusValues } from '@repolens/shared-types';

import { asyncHandler } from '../middleware/asyncHandler';
import type { CorrelationRequest } from '../middleware/correlationId';
import { ROUTING_KEYS } from '../queue/constants';
import { publishMessage } from '../queue/publisher';
import { JobModel } from '../models/Job';

export const jobsRouter = Router();
const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'intake-service',
});

const forbiddenRepoUrlFragments = ['example', 'sample', 'test', 'your-org', 'your-repo'];

const sanitizePayloadForLog = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: typeof value };
  }
  const record = value as Record<string, unknown>;
  const repoUrlValue = typeof record.repoUrl === 'string' ? record.repoUrl.trim() : undefined;
  return {
    keys: Object.keys(record),
    repoUrl: repoUrlValue ? repoUrlValue.slice(0, 256) : undefined,
  };
};

const isForbiddenRepoUrl = (repoUrl: string) => {
  const normalized = repoUrl.toLowerCase();
  return forbiddenRepoUrlFragments.some((fragment) => normalized.includes(fragment));
};

jobsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    logger.info(
      { stage: 'INTAKE_RECEIVED', payload: sanitizePayloadForLog(req.body) },
      'Received raw client payload',
    );

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    const payload = req.body as Record<string, unknown>;
    const payloadKeys = Object.keys(payload);
    if (payloadKeys.length !== 1 || payloadKeys[0] !== 'repoUrl') {
      res.status(400).json({ error: 'UNSUPPORTED_PAYLOAD_FIELDS' });
      return;
    }

    const repoUrl = payload.repoUrl;

    if (!repoUrl || typeof repoUrl !== 'string' || !isValidGithubRepoUrl(repoUrl)) {
      res.status(400).json({ error: 'INVALID_REPO_URL' });
      return;
    }
    const trimmedRepoUrl = repoUrl.trim();
    if (isForbiddenRepoUrl(trimmedRepoUrl)) {
      res.status(400).json({ error: 'DEFAULT_OR_TEST_REPO_URL_REJECTED' });
      return;
    }

    const job = await JobModel.create({
      repoUrl: trimmedRepoUrl,
      status: 'QUEUED',
    });
    const correlationId = (req as CorrelationRequest).correlationId;
    logJobEvent(logger, {
      jobId: job.id,
      stage: 'QUEUED',
      message: 'Job created',
      fields: { repoUrl: job.repoUrl, correlationId },
    });

    try {
      const channel = await req.app.locals.getChannel();
      await publishMessage(channel, ROUTING_KEYS.jobCreated, {
        jobId: job.id,
        repoUrl: job.repoUrl,
      });
      logJobEvent(logger, {
        jobId: job.id,
        stage: 'QUEUED',
        message: 'Published job.created',
        fields: { routingKey: ROUTING_KEYS.jobCreated },
      });
    } catch (_error) {
      await JobModel.findByIdAndUpdate(job.id, {
        status: 'FAILED',
        error: 'PUBLISH_FAILED',
      });
      logJobEvent(logger, {
        jobId: job.id,
        stage: 'FAILED',
        level: 'error',
        message: 'Failed to publish job.created',
        fields: { routingKey: ROUTING_KEYS.jobCreated },
      });
      res.status(502).json({ jobId: job.id, status: 'FAILED' });
      return;
    }

    res.status(201).json({ jobId: job.id, status: job.status });
  }),
);

jobsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const status = req.query.status?.toString();
    if (status && !jobStatusValues.includes(status as (typeof jobStatusValues)[number])) {
      res.status(400).json({ error: 'INVALID_STATUS' });
      return;
    }
    const filter = status ? { status } : {};

    const jobs = await JobModel.find(filter).sort({ updatedAt: -1 }).lean();
    res.json(jobs);
  }),
);

jobsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const job = await JobModel.findById(req.params.id).lean();
    if (!job) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    res.json(job);
  }),
);
