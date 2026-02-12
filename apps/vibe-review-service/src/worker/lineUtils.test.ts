import assert from 'node:assert/strict';
import test from 'node:test';

import { getLineInfo, getSnippetByIndex } from './reviewRunner';

test('getLineInfo handles CRLF and first/last lines', () => {
  const content = 'first\r\nsecond\r\nthird';
  assert.deepEqual(getLineInfo(content, 0), { line: 1 });
  assert.deepEqual(getLineInfo(content, content.indexOf('second')), { line: 2 });
  assert.deepEqual(getLineInfo(content, content.indexOf('third')), { line: 3 });
});

test('getLineInfo handles no trailing newline and multiline ranges', () => {
  const content = 'a\nb\nc';
  const start = content.indexOf('b');
  const end = content.length;
  assert.deepEqual(getLineInfo(content, start, end), { line: 2, endLine: 3 });
});

test('getSnippetByIndex returns deterministic snippet bounds', () => {
  const content = 'alpha\nbeta\ngamma\ndelta';
  const start = content.indexOf('gamma');
  const result = getSnippetByIndex(content, start, start + 'gamma'.length, 1);

  assert.equal(result.snippetStartLine, 2);
  assert.equal(result.snippetEndLine, 4);
  assert.match(result.snippet, /2\s+\|\s+beta/);
  assert.match(result.snippet, /3\s+\|\s+gamma/);
  assert.match(result.snippet, /4\s+\|\s+delta/);
});

test('getLineInfo handles large files with deterministic mapping', () => {
  const content = `${'line\n'.repeat(50_000)}tail`;
  const index = content.lastIndexOf('tail');
  const result = getLineInfo(content, index, index + 4);

  assert.deepEqual(result, { line: 50_001 });
});
