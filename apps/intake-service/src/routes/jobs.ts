import { Router } from 'express';
import type { Request, Response } from 'express';

import { isValidGithubRepoUrl } from '@repolens/shared-utils';
import { jobStatusValues } from '@repolens/shared-types';

import { asyncHandler } from '../middleware/asyncHandler';
import { ROUTING_KEYS } from '../queue/constants';
import { publishMessage } from '../queue/publisher';
import { JobModel } from '../models/Job';

export const jobsRouter = Router();

jobsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const repoUrl = req.body?.repoUrl;

    if (!repoUrl || typeof repoUrl !== 'string' || !isValidGithubRepoUrl(repoUrl)) {
      res.status(400).json({ error: 'INVALID_REPO_URL' });
      return;
    }

    const job = await JobModel.create({
      repoUrl: repoUrl.trim(),
      status: 'QUEUED',
    });

    try {
      const channel = await req.app.locals.getChannel();
      await publishMessage(channel, ROUTING_KEYS.jobCreated, {
        jobId: job.id,
        repoUrl: job.repoUrl,
      });
    } catch (_error) {
      await JobModel.findByIdAndUpdate(job.id, {
        status: 'FAILED',
        error: 'PUBLISH_FAILED',
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
