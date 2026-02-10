import { promises as fs } from 'fs';
import path from 'path';

import { createLogger } from '@repolens/shared-utils';
import type { ReviewResults } from '@repolens/shared-types';

import { JobModel } from '../models/Job';
import { createVibeManifest } from '../utils/vibeManifest';
import { formatAndStoreResults, runReviewForJob } from './reviewRunner';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'vibe-review-service',
});

// Main job review handler that supports partial results on failure.
export const processJobFetchedMessage = async (payload: { jobId?: string; localPath?: string }) => {
  const jobId = payload.jobId;
  if (!jobId) {
    throw new Error('JOB_ID_MISSING');
  }

  const job = await JobModel.findById(jobId);
  if (!job) {
    throw new Error('JOB_NOT_FOUND');
  }

  if (job.status !== 'FETCHED') {
    logger.info({ jobId, status: job.status }, 'Skipping job not in FETCHED status');
    return;
  }

  const localPath = payload.localPath ?? job.localPath ?? '';
  const resolvedLocalPath = localPath ? path.resolve(localPath) : '';

  if (!resolvedLocalPath) {
    job.status = 'FAILED';
    job.error = 'INVALID_LOCAL_PATH';
    await job.save();
    logger.error({ jobId }, 'Missing local path for review');
    return;
  }

  try {
    const stats = await fs.stat(resolvedLocalPath);
    if (!stats.isDirectory()) {
      throw new Error('LOCAL_PATH_NOT_DIRECTORY');
    }
  } catch (error) {
    job.status = 'FAILED';
    job.error = 'INVALID_LOCAL_PATH';
    await job.save();
    logger.error({ jobId, localPath: resolvedLocalPath, error }, 'Invalid local path for review');
    return;
  }

  job.status = 'REVIEWING';
  await job.save();
  logger.info({ jobId, stage: 'REVIEWING' }, 'Review started');

  try {
    await createVibeManifest(resolvedLocalPath, {
      jobId: job.id,
      repoUrl: job.repoUrl,
      localPath: resolvedLocalPath,
      createdAt: new Date().toISOString(),
    });

    const answers = await runReviewForJob(resolvedLocalPath);
    const reviewResults = await formatAndStoreResults(jobId, answers);

    job.status = 'COMPLETED';
    job.reviewResults = reviewResults;
    await job.save();
    logger.info({ jobId, stage: 'COMPLETED' }, 'Review completed');
  } catch (error) {
    const partialAnswers =
      (error as Error & { partialResults?: ReviewResults['questions'] }).partialResults ??
      job.reviewResults?.questions ??
      [];
    const partial = await formatAndStoreResults(jobId, partialAnswers);
    job.reviewResults = partial;
    job.status = 'FAILED';
    job.error = 'REVIEW_FAILED';
    await job.save();
    logger.error({ jobId, stage: 'FAILED', error: job.error }, 'Review failed');
    throw error;
  }
};
