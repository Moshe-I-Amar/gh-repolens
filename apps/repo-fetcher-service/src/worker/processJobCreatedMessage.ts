import path from 'path';
import { promises as fs } from 'fs';

import { createLogger } from '@repolens/shared-utils';

import { Channel } from 'amqplib';

import { JobModel } from '../models/Job';
import { ROUTING_KEYS } from '../queue/constants';
import { publishMessage } from '../queue/publisher';
import { cleanupWorkspace, downloadRepoArchive, safeExtractZip } from '../utils/archive';

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const parseLimit = (value: string | undefined, fallback: number) => {
  const parsed = value ? Number(value) : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
};

// Main consumer handler for job.created messages.
export const processJobCreatedMessage = async (
  channel: Channel,
  payload: { jobId?: string },
) => {
  const jobId = payload.jobId;
  if (!jobId) {
    throw new Error('JOB_ID_MISSING');
  }

  const job = await JobModel.findById(jobId);
  if (!job) {
    throw new Error('JOB_NOT_FOUND');
  }

  if (job.status !== 'QUEUED') {
    logger.info({ jobId, status: job.status }, 'Skipping job not in QUEUED status');
    return;
  }

  job.status = 'FETCHING';
  await job.save();

  const workspaceRoot = process.env.WORKSPACES_ROOT ?? '/workspaces';
  const workspacePath = path.join(workspaceRoot, jobId);
  const repoPath = path.join(workspacePath, 'repo');
  const archivePath = path.join(workspacePath, 'archive.zip');

  const sizeLimit = parseLimit(process.env.ZIP_SIZE_LIMIT_MB, 200) * 1024 * 1024;
  const fileCountLimit = parseLimit(process.env.ZIP_FILE_COUNT_LIMIT, 50000);
  const downloadTimeout = parseLimit(process.env.DOWNLOAD_TIMEOUT_MS, 300000);
  const extractTimeout = parseLimit(process.env.EXTRACT_TIMEOUT_MS, 300000);
  const totalExtractedLimit =
    parseLimit(process.env.TOTAL_EXTRACTED_SIZE_LIMIT_MB, 500) * 1024 * 1024;

  try {
    await fs.mkdir(workspacePath, { recursive: true });
    await downloadRepoArchive(job.repoUrl, archivePath, sizeLimit, downloadTimeout);
    await safeExtractZip(
      archivePath,
      repoPath,
      fileCountLimit,
      extractTimeout,
      totalExtractedLimit,
    );
    try {
      await fs.rm(archivePath, { force: true });
    } catch (error) {
      logger.warn({ error, archivePath }, 'Failed to remove archive after extraction');
    }

    job.status = 'FETCHED';
    job.localPath = repoPath;
    await job.save();

    await publishMessage(
      channel,
      ROUTING_KEYS.jobFetched,
      { jobId: job.id, localPath: repoPath },
      logger,
    );
  } catch (error) {
    job.status = 'FAILED';
    job.error = error instanceof Error ? error.message : 'FETCH_FAILED';
    await job.save();

    await cleanupWorkspace(workspacePath);
    throw error;
  }
};
