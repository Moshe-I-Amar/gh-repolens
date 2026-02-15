import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const createFile = async (root: string, relativePath: string, content: string) => {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
};

test('runReviewForJob completes with rules fallback when Codex request fails', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'review-codex-fallback-'));

  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  try {
    // Minimal repo contents so scanRepoFiles has something to analyze.
    await createFile(
      tempRoot,
      'src/app.ts',
      ['export const ok = true;', 'console.log("hello");'].join('\n'),
    );

    process.env.REVIEW_USE_CODEX = 'true';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.REVIEW_MODEL = 'codex-mini-latest';

    // Force OpenAI client calls to fail without real network.
    globalThis.fetch = async () => {
      throw new Error('SIMULATED_FETCH_FAILURE');
    };

    // Cache-bust the module so it picks up env vars above (other tests import reviewRunner).
    const reviewRunnerPath = path.join(__dirname, 'reviewRunner.js');
    const reviewRunnerUrl = pathToFileURL(reviewRunnerPath);
    reviewRunnerUrl.search = `?t=${Date.now()}`;
    const { runReviewForJob } = (await import(reviewRunnerUrl.href)) as typeof import('./reviewRunner');

    const answers = await runReviewForJob('job-1', tempRoot);
    assert.equal(answers.length, 6);
    assert.ok(
      answers.some((answer) => answer.answer.includes('rules-based fallback')),
      'expected at least one fallback answer when Codex fails',
    );
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
