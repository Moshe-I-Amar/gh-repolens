import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEvidenceRefs } from './reviewRunner';

test('resolveEvidenceRefs computes verified line numbers from evidence', () => {
  const repoFiles = [
    {
      path: 'src/app.ts',
      content: ['const q = "SELECT * FROM users";', 'console.log(q);'].join('\n'),
    },
  ];

  const result = resolveEvidenceRefs(repoFiles, [
    { path: 'src/app.ts', evidence: 'SELECT * FROM users' },
  ]);

  assert.equal(result.verifiedCount, 1);
  assert.equal(result.unverifiedCount, 0);
  assert.equal(result.refs[0]?.path, 'src/app.ts');
  assert.equal(result.refs[0]?.line, 1);
});

test('resolveEvidenceRefs marks unverified references when evidence is missing', () => {
  const repoFiles = [
    {
      path: 'src/app.ts',
      content: 'const value = 1;',
    },
  ];

  const result = resolveEvidenceRefs(repoFiles, [
    { path: 'src/app.ts', evidence: 'this text does not exist' },
  ]);

  assert.equal(result.verifiedCount, 0);
  assert.equal(result.unverifiedCount, 1);
  assert.deepEqual(result.refs[0], { path: 'src/app.ts' });
});
