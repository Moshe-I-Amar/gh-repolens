import path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { createLogger, logJobEvent } from '@repolens/shared-utils';

import { ConfirmChannel } from 'amqplib';

import { JobModel } from '../models/Job';
import { ROUTING_KEYS } from '../queue/constants';
import { publishMessage } from '../queue/publisher';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'repo-fetcher-service',
});

const execFileAsync = promisify(execFile);
const MAX_READABLE_SAMPLE_FILES = 10;
const MAX_WALK_FILES = 5000;
const READABLE_TEXT_EXTENSIONS = new Set([
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

const countReadableFiles = async (
  rootPath: string,
): Promise<{ count: number; samplePaths: string[] }> => {
  const samplePaths: string[] = [];
  let count = 0;
  let visited = 0;

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (visited >= MAX_WALK_FILES) {
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
      visited += 1;
      const extension = path.extname(entry.name).toLowerCase();
      if (!READABLE_TEXT_EXTENSIONS.has(extension) && entry.name !== 'README') {
        continue;
      }
      try {
        await fs.access(fullPath, fs.constants.R_OK);
        count += 1;
        if (samplePaths.length < MAX_READABLE_SAMPLE_FILES) {
          samplePaths.push(path.relative(rootPath, fullPath));
        }
      } catch {
        // Non-readable files are ignored by design.
      }
    }
  };

  await walk(rootPath);
  return { count, samplePaths };
};

const cloneRepository = async (repoUrl: string, targetPath: string) => {
  try {
    await execFileAsync('git', ['clone', '--depth', '1', repoUrl, targetPath], {
      windowsHide: true,
      timeout: Number(process.env.CLONE_TIMEOUT_MS ?? 300000),
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GIT_CLONE_FAILED';
    throw new Error(`GIT_CLONE_FAILED:${message}`);
  }
};

// Main consumer handler for job.created messages.
export const processJobCreatedMessage = async (
  channel: ConfirmChannel,
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
  logJobEvent(logger, {
    jobId,
    stage: 'FETCHING',
    message: 'Job status updated',
    fields: { repoUrl: job.repoUrl },
  });

  const workspaceRoot = process.env.WORKSPACES_ROOT ?? '/workspaces';
  const workspacePath = path.join(workspaceRoot, jobId);
  const repoPath = path.join(workspacePath, 'repo');

  try {
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.mkdir(workspacePath, { recursive: true });
    await cloneRepository(job.repoUrl, repoPath);
    logJobEvent(logger, {
      jobId,
      stage: 'FETCHING',
      message: 'Repository cloned from client repoUrl',
      fields: { localPath: repoPath, repoUrl: job.repoUrl },
    });

    const stats = await fs.stat(repoPath);
    if (!stats.isDirectory()) {
      throw new Error('CLONE_PATH_NOT_DIRECTORY');
    }

    const readableFiles = await countReadableFiles(repoPath);
    if (readableFiles.count === 0) {
      throw new Error('NO_READABLE_FILES');
    }

    job.status = 'FETCHED';
    job.localPath = repoPath;
    await job.save();
    logJobEvent(logger, {
      jobId,
      stage: 'FETCHED',
      message: 'Repo fetched and cloned',
      fields: {
        localPath: repoPath,
        readableFileCount: readableFiles.count,
        samplePaths: readableFiles.samplePaths,
      },
    });

    await publishMessage(
      channel,
      ROUTING_KEYS.jobFetched,
      {
        jobId: job.id,
        localPath: repoPath,
        readableFileCount: readableFiles.count,
        samplePaths: readableFiles.samplePaths,
      },
      logger,
    );
  } catch (error) {
    job.status = 'FAILED';
    job.error = error instanceof Error ? error.message : 'FETCH_FAILED';
    await job.save();
    logJobEvent(logger, {
      jobId,
      stage: 'FAILED',
      level: 'error',
      message: 'Repo fetch failed',
      fields: { error: job.error },
    });

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } catch (cleanupError) {
      logger.error({ cleanupError, workspacePath }, 'Failed to cleanup workspace');
    }
    throw error;
  }
};
