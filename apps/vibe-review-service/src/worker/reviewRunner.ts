import path from 'path';
import { promises as fs } from 'fs';

import { createLogger } from '@repolens/shared-utils';
import { ReviewAnswer, ReviewResults } from '@repolens/shared-types';

import { reviewQuestions } from '../review/questions';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'vibe-review-service',
});

const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILES = 20;
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 600000);

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string) => {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs),
    ),
  ]);
};

const readFileSafe = async (filePath: string) => {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return null;
    }
    if (stats.size > MAX_FILE_BYTES) {
      return null;
    }
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
};

const selectInterestingFiles = async (root: string) => {
  const candidates = [
    'package.json',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsconfig.base.json',
    'README.md',
  ];

  const picks: string[] = [];

  for (const candidate of candidates) {
    const candidatePath = path.join(root, candidate);
    const contents = await readFileSafe(candidatePath);
    if (contents) {
      picks.push(candidatePath);
      if (picks.length >= MAX_FILES) {
        return picks;
      }
    }
  }

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (picks.length >= MAX_FILES) {
        return;
      }

      if (entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build'].includes(entry.name)) {
          continue;
        }
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.match(/\.(ts|tsx|js|json|yml|yaml)$/)) {
        const contents = await readFileSafe(fullPath);
        if (contents) {
          picks.push(fullPath);
        }
      }
    }
  };

  await walk(root);
  return picks;
};

// Gathers context snippets for a given question without loading the whole repo.
export const getContextForQuestion = async (repoRoot: string, questionId: string) => {
  const files = await selectInterestingFiles(repoRoot);
  const snippets: { path: string; content: string }[] = [];

  for (const filePath of files) {
    const content = await readFileSafe(filePath);
    if (content) {
      snippets.push({ path: path.relative(repoRoot, filePath), content });
    }
  }

  return {
    questionId,
    files: snippets,
  };
};

const summarizeQuestion = (questionId: string) => {
  const question = reviewQuestions.find((item) => item.id === questionId);
  return question?.title ?? questionId;
};

// Stores results while preserving partial progress.
export const formatAndStoreResults = async (jobId: string, results: ReviewAnswer[]) => {
  // TODO: persist results using jobId once a storage layer is introduced.
  const existing: ReviewResults = {
    questions: results,
  };

  return existing;
};

// Runs the 10-question review; swap adapter later for Codex/Vibe automation.
export const runReviewForJob = async (repoRoot: string): Promise<ReviewAnswer[]> => {
  const answers: ReviewAnswer[] = [];

  const run = async () => {
    for (const question of reviewQuestions) {
      try {
        const context = await getContextForQuestion(repoRoot, question.id);
        const answer = `Summary: Context snapshot for ${summarizeQuestion(question.id)}.
Findings: Collected ${context.files.length} files for review context.
Risk/Severity: LOW (context captured; no automated analysis performed).
File references: ${context.files.map((file) => file.path).join(', ') || 'N/A'}.`;

        answers.push({
          id: question.id,
          title: question.title,
          category: question.category,
          severity: 'LOW',
          answer,
          refs: context.files.map((file) => ({ path: file.path })),
        });
      } catch (error) {
        const partialError = new Error('REVIEW_QUESTION_FAILED');
        (partialError as Error & { partialResults?: ReviewAnswer[] }).partialResults = answers;
        logger.error({ error, questionId: question.id }, 'Question review failed');
        throw partialError;
      }
    }
  };

  await withTimeout(run(), REVIEW_TIMEOUT_MS, 'REVIEW');
  return answers;
};
