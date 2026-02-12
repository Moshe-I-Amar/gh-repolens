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

test('scanRepoFiles includes special-name allowlist files even when extension filter would exclude them', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'scan-special-'));
  try {
    await createFile(tempRoot, 'src/Dockerfile', 'FROM node:20-alpine');
    await createFile(tempRoot, 'src/Makefile', 'all:\n\techo ok');
    await createFile(tempRoot, 'src/.env.example', 'FOO=bar');
    await createFile(tempRoot, 'src/.eslintrc.custom', '{"root": true}');
    await createFile(tempRoot, 'src/.prettierrc.custom', '{"semi": true}');
    await createFile(tempRoot, 'src/requirements.txt', 'flask==3.0.0');

    // Control file to ensure filtering still works.
    await createFile(tempRoot, 'src/random.custom', 'should not be included');

    const result = await scanRepoFiles(tempRoot, {
      maxFiles: 20,
      includeDeprioritized: true,
    });

    const scannedPaths = new Set(result.files.map((file) => file.path.replace(/\\/g, '/')));

    assert.equal(scannedPaths.has('src/Dockerfile'), true);
    assert.equal(scannedPaths.has('src/Makefile'), true);
    assert.equal(scannedPaths.has('src/.env.example'), true);
    assert.equal(scannedPaths.has('src/.eslintrc.custom'), true);
    assert.equal(scannedPaths.has('src/.prettierrc.custom'), true);
    assert.equal(scannedPaths.has('src/requirements.txt'), true);
    assert.equal(scannedPaths.has('src/random.custom'), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
