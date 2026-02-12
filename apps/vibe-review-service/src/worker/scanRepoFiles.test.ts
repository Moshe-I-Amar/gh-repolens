import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scanRepoFiles } from './reviewRunner';

const createFile = async (root: string, relativePath: string, content: string) => {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf8');
};

test('scanRepoFiles prioritizes src/lib/apps/server before non-priority paths when maxFiles is reached', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'scan-priority-'));
  try {
    await createFile(tempRoot, 'docs/guide.ts', 'export const docs = true;');
    await createFile(tempRoot, 'tests/spec.ts', 'export const tests = true;');
    await createFile(tempRoot, 'misc/other.ts', 'export const misc = true;');
    await createFile(tempRoot, 'src/a.ts', 'export const src = true;');
    await createFile(tempRoot, 'lib/b.ts', 'export const lib = true;');
    await createFile(tempRoot, 'apps/c.ts', 'export const apps = true;');
    await createFile(tempRoot, 'server/d.ts', 'export const server = true;');

    const result = await scanRepoFiles(tempRoot, {
      maxFiles: 4,
      includeDeprioritized: false,
    });

    const scannedPaths = result.files.map((file) => file.path.replace(/\\/g, '/'));
    assert.deepEqual(scannedPaths, ['src/a.ts', 'lib/b.ts', 'apps/c.ts', 'server/d.ts']);
    assert.equal(result.stats.priorityPassCount, 4);
    assert.equal(result.stats.nonPriorityPassCount, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
