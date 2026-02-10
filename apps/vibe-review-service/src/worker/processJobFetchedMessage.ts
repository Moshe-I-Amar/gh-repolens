import { promises as fs } from 'fs';
import path from 'path';

import { createLogger, logJobEvent } from '@repolens/shared-utils';
import type { ReviewResults } from '@repolens/shared-types';

import { JobModel } from '../models/Job';
import { jobFetchedPayloadSchema } from '../review/schemas';
import { createVibeManifest } from '../utils/vibeManifest';
import { formatAndStoreResults, runReviewForJob } from './reviewRunner';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'vibe-review-service',
});

// Main job review handler that supports partial results on failure.
export const processJobFetchedMessage = async (payload: { jobId?: string; localPath?: string }) => {
  const parsedPayload = jobFetchedPayloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    throw new Error('INVALID_JOB_FETCHED_PAYLOAD');
  }
  const { jobId, localPath: payloadLocalPath } = parsedPayload.data;

  const job = await JobModel.findById(jobId);
  if (!job) {
    throw new Error('JOB_NOT_FOUND');
  }

  if (job.status !== 'FETCHED') {
    logger.info({ jobId, status: job.status }, 'Skipping job not in FETCHED status');
    return;
  }

  const localPath = payloadLocalPath ?? job.localPath ?? '';
  const resolvedLocalPath = localPath ? path.resolve(localPath) : '';

  if (!resolvedLocalPath) {
    job.status = 'FAILED';
    job.error = 'INVALID_LOCAL_PATH';
    await job.save();
    logJobEvent(logger, {
      jobId,
      stage: 'FAILED',
      level: 'error',
      message: 'Missing local path for review',
      fields: { error: job.error },
    });
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
    logJobEvent(logger, {
      jobId,
      stage: 'FAILED',
      level: 'error',
      message: 'Invalid local path for review',
      fields: { localPath: resolvedLocalPath, error, errorCode: job.error },
    });
    return;
  }

  job.status = 'REVIEWING';
  await job.save();
  const reviewStartedAt = Date.now();
  logJobEvent(logger, {
    jobId,
    stage: 'REVIEWING',
    message: 'Review started',
  });

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
    const finishedAt = Date.now();
    logJobEvent(logger, {
      jobId,
      stage: 'COMPLETED',
      message: 'Review completed',
      fields: {
        reviewDurationMs: finishedAt - reviewStartedAt,
        totalDurationMs: finishedAt - new Date(job.createdAt).getTime(),
      },
    });
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
    const failedAt = Date.now();
    logJobEvent(logger, {
      jobId,
      stage: 'FAILED',
      level: 'error',
      message: 'Review failed',
      fields: {
        error: job.error,
        reviewDurationMs: failedAt - reviewStartedAt,
        totalDurationMs: failedAt - new Date(job.createdAt).getTime(),
      },
    });
    throw error;
  }
};
