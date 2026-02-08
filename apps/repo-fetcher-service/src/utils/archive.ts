import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import unzipper, { type Entry } from 'unzipper';
import { fetch } from 'undici';

import { createLogger } from '@repolens/shared-utils';

const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string) => {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs),
    ),
  ]);
};

const fetchJson = async (url: string, timeoutMs: number) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RepoLens' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GITHUB_API_${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
};

export const resolveDefaultBranch = async (
  repoUrl: string,
  timeoutMs: number,
): Promise<string> => {
  const match = repoUrl.match(/github\.com\/(.+?)\/(.+?)(\.git)?\/?$/);
  if (!match) {
    throw new Error('INVALID_REPO_URL');
  }

  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) {
    throw new Error('INVALID_REPO_URL');
  }
  const cleanRepo = repo.replace(/\.git$/, '');
  const apiUrl = `https://api.github.com/repos/${owner}/${cleanRepo}`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const payload = (await withTimeout(
        fetchJson(apiUrl, timeoutMs),
        timeoutMs,
        'GITHUB_API',
      )) as { default_branch?: string };
      return payload.default_branch ?? 'main';
    } catch (error) {
      logger.error({ error, attempt }, 'Failed to resolve default branch');
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
    }
  }

  return 'main';
};

const downloadWithRetry = async (url: string, attempts: number, timeoutMs: number) => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await withTimeout(
          fetch(url, {
            headers: { 'User-Agent': 'RepoLens' },
            signal: controller.signal,
          }),
          timeoutMs,
          'DOWNLOAD',
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
    }
  }

  throw lastError;
};

// Downloads a GitHub archive with size limits and retry/backoff.
export const downloadRepoArchive = async (
  repoUrl: string,
  targetPath: string,
  sizeLimitBytes: number,
  timeoutMs: number,
): Promise<void> => {
  const branch = await resolveDefaultBranch(repoUrl, timeoutMs);
  const match = repoUrl.match(/github\.com\/(.+?)\/(.+?)(\.git)?\/?$/);
  if (!match) {
    throw new Error('INVALID_REPO_URL');
  }

  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) {
    throw new Error('INVALID_REPO_URL');
  }
  const cleanRepo = repo.replace(/\.git$/, '');
  const zipUrl = `https://github.com/${owner}/${cleanRepo}/archive/refs/heads/${branch}.zip`;

  const response = await downloadWithRetry(zipUrl, 3, timeoutMs);
  if (!response.ok || !response.body) {
    throw new Error(`ZIP_DOWNLOAD_FAILED_${response.status}`);
  }

  const fileStream = createWriteStream(targetPath);
  let totalBytes = 0;

  for await (const chunk of response.body) {
    totalBytes += chunk.length;
    if (totalBytes > sizeLimitBytes) {
      await response.body.cancel(new Error('ZIP_SIZE_LIMIT_EXCEEDED'));
      throw new Error('ZIP_SIZE_LIMIT_EXCEEDED');
    }
    fileStream.write(chunk);
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end(() => resolve());
    fileStream.on('error', reject);
  });
};

const isWithin = (targetPath: string, root: string) => {
  const resolved = path.resolve(targetPath);
  return resolved.startsWith(path.resolve(root) + path.sep);
};

// Safely extracts a zip archive with zip-slip protection and file limits.
export const safeExtractZip = async (
  zipPath: string,
  destination: string,
  fileCountLimit: number,
  timeoutMs: number,
): Promise<void> => {
  await fs.mkdir(destination, { recursive: true });
  const archive = await unzipper.Open.file(zipPath);

  let fileCount = 0;
  const extraction = archive.files.reduce<Promise<void>>(async (prev: Promise<void>, entry: Entry) => {
    await prev;

    if (entry.type === 'Directory') {
      return;
    }

    if (entry.type !== 'File') {
      entry.autodrain();
      return;
    }

    fileCount += 1;
    if (fileCount > fileCountLimit) {
      throw new Error('ZIP_FILE_COUNT_LIMIT_EXCEEDED');
    }

    const relativePath = entry.path.replace(/^\/+/, '');
    const targetPath = path.join(destination, relativePath);

    if (!isWithin(targetPath, destination)) {
      throw new Error('ZIP_SLIP_DETECTED');
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await pipeline(entry.stream(), createWriteStream(targetPath));
  }, Promise.resolve());

  await withTimeout(extraction, timeoutMs, 'EXTRACT');
};

export const cleanupWorkspace = async (workspace: string) => {
  try {
    await fs.rm(workspace, { recursive: true, force: true });
  } catch (error) {
    logger.error({ error, workspace }, 'Failed to cleanup workspace');
  }
};
