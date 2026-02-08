import { createLogger } from '@repolens/shared-utils';

import { JobModel } from '../models/Job';
import { createVibeManifest } from '../utils/vibeManifest';
import { formatAndStoreResults, runReviewForJob } from './reviewRunner';

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

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

  job.status = 'REVIEWING';
  await job.save();

  try {
    await createVibeManifest(payload.localPath ?? job.localPath ?? '', {
      jobId: job.id,
      repoUrl: job.repoUrl,
      localPath: payload.localPath ?? job.localPath ?? '',
      createdAt: new Date().toISOString(),
    });

    const answers = await runReviewForJob(payload.localPath ?? job.localPath ?? '');
    const reviewResults = await formatAndStoreResults(jobId, answers);

    job.status = 'COMPLETED';
    job.reviewResults = reviewResults;
    await job.save();
  } catch (error) {
    const partial = await formatAndStoreResults(jobId, job.reviewResults?.questions ?? []);
    job.reviewResults = partial;
    job.status = 'FAILED';
    job.error = 'REVIEW_FAILED';
    await job.save();
    throw error;
  }
};
