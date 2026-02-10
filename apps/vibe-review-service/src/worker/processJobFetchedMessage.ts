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

const MAX_READABLE_SAMPLE_FILES = 10;
const MAX_SCAN_FILES = 5000;
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.idea',
  '.vscode',
]);
const readableExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.java',
  '.go',
  '.py',
  '.rb',
  '.php',
  '.cs',
  '.rs',
  '.kt',
  '.swift',
  '.sql',
  '.html',
  '.css',
  '.scss',
]);

const collectReadableFiles = async (
  rootPath: string,
): Promise<{ count: number; samplePaths: string[] }> => {
  const samplePaths: string[] = [];
  let count = 0;
  let scanned = 0;

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (scanned >= MAX_SCAN_FILES) {
        return;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          continue;
        }
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      scanned += 1;
      const extension = path.extname(entry.name).toLowerCase();
      if (!readableExtensions.has(extension) && entry.name !== 'README') {
        continue;
      }
      try {
        await fs.access(fullPath, fs.constants.R_OK);
        count += 1;
        if (samplePaths.length < MAX_READABLE_SAMPLE_FILES) {
          samplePaths.push(path.relative(rootPath, fullPath));
        }
      } catch {
        // Ignore files that cannot be read.
      }
    }
  };

  await walk(rootPath);
  return { count, samplePaths };
};

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

  const resolvedLocalPath = path.resolve(payloadLocalPath);

  if (!job.localPath || path.resolve(job.localPath) !== resolvedLocalPath) {
    job.status = 'FAILED';
    job.error = 'LOCAL_PATH_MISMATCH';
    await job.save();
    logJobEvent(logger, {
      jobId,
      stage: 'FAILED',
      level: 'error',
      message: 'job.fetched localPath does not match persisted job.localPath',
      fields: { payloadLocalPath: resolvedLocalPath, persistedLocalPath: job.localPath, error: job.error },
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

  const readableFiles = await collectReadableFiles(resolvedLocalPath);
  if (readableFiles.count === 0) {
    job.status = 'FAILED';
    job.error = 'NO_READABLE_FILES';
    await job.save();
    logJobEvent(logger, {
      jobId,
      stage: 'FAILED',
      level: 'error',
      message: 'Repository contains no readable files for analysis',
      fields: { localPath: resolvedLocalPath, error: job.error },
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
    fields: {
      localPath: resolvedLocalPath,
      readableFileCount: readableFiles.count,
      samplePaths: readableFiles.samplePaths,
    },
  });

  try {
    await createVibeManifest(resolvedLocalPath, {
      jobId: job.id,
      repoUrl: job.repoUrl,
      localPath: resolvedLocalPath,
      createdAt: new Date().toISOString(),
    });

    const answers = await runReviewForJob(jobId, resolvedLocalPath);
    const reviewResults = await formatAndStoreResults(jobId, answers);

    job.status = 'COMPLETED';
    job.reviewResults = reviewResults;
    await job.save();
    logger.info(
      {
        jobId,
        stage: 'COMPLETED',
        mongoCollection: 'jobs',
        reviewQuestionCount: reviewResults.questions.length,
        riskLevel: reviewResults.riskSummary?.level,
      },
      'MongoDB write confirmed for review results',
    );
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
    job.error = error instanceof Error ? error.message : 'REVIEW_FAILED';
    await job.save();
    logger.error(
      {
        jobId,
        stage: 'FAILED',
        mongoCollection: 'jobs',
        reviewQuestionCount: partial.questions.length,
        error: job.error,
      },
      'MongoDB write confirmed for failed review',
    );
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
