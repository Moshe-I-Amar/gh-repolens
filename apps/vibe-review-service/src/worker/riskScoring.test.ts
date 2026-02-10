import test from 'node:test';
import assert from 'node:assert/strict';

import type { ReviewAnswer } from '@repolens/shared-types';

import { calculateRiskSummary } from './riskScoring';

const answer = (severity: string): ReviewAnswer => ({
  id: `q-${severity}`,
  title: 't',
  category: 'SECURITY',
  severity,
  answer: 'a',
  refs: [],
});

test('returns NONE for no findings', () => {
  const result = calculateRiskSummary([]);
  assert.equal(result.level, 'NONE');
  assert.equal(result.score, 0);
});

test('maps mixed severities using weights and thresholds', () => {
  const result = calculateRiskSummary([answer('HIGH'), answer('MEDIUM'), answer('LOW')]);
  assert.equal(result.score, 12);
  assert.equal(result.level, 'HIGH');
  assert.equal(result.counts.HIGH, 1);
  assert.equal(result.counts.MEDIUM, 1);
  assert.equal(result.counts.LOW, 1);
});

test('normalizes unknown severities to UNKNOWN with zero weight', () => {
  const result = calculateRiskSummary([answer('foo'), answer('info')]);
  assert.equal(result.score, 0);
  assert.equal(result.level, 'NONE');
  assert.equal(result.counts.UNKNOWN, 1);
  assert.equal(result.counts.INFO, 1);
});

test('promotes to CRITICAL when score threshold is met', () => {
  const result = calculateRiskSummary([answer('CRITICAL'), answer('HIGH'), answer('MEDIUM')]);
  assert.equal(result.score, 21);
  assert.equal(result.level, 'CRITICAL');
});

