import type { ReviewAnswer, ReviewSeverity, RiskLevel, RiskSummary } from '@repolens/shared-types';

const severityWeights: Record<ReviewSeverity, number> = {
  CRITICAL: 10,
  HIGH: 7,
  MEDIUM: 4,
  LOW: 1,
  INFO: 0,
  UNKNOWN: 0,
};

const riskThresholds: Array<{ minScore: number; level: RiskLevel }> = [
  { minScore: 20, level: 'CRITICAL' },
  { minScore: 12, level: 'HIGH' },
  { minScore: 6, level: 'MEDIUM' },
  { minScore: 1, level: 'LOW' },
  { minScore: 0, level: 'NONE' },
];

const normalizeSeverity = (value: string): ReviewSeverity => {
  const normalized = value.trim().toUpperCase();
  if (
    normalized === 'CRITICAL' ||
    normalized === 'HIGH' ||
    normalized === 'MEDIUM' ||
    normalized === 'LOW' ||
    normalized === 'INFO'
  ) {
    return normalized;
  }
  return 'UNKNOWN';
};

const levelForScore = (score: number): RiskLevel => {
  const threshold = riskThresholds.find((item) => score >= item.minScore);
  return threshold?.level ?? 'NONE';
};

export const calculateRiskSummary = (answers: ReviewAnswer[]): RiskSummary => {
  const counts: Record<ReviewSeverity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
    UNKNOWN: 0,
  };

  let score = 0;
  for (const answer of answers) {
    const severity = normalizeSeverity(answer.severity);
    counts[severity] += 1;
    score += severityWeights[severity];
  }

  return {
    level: levelForScore(score),
    score,
    counts,
  };
};

export const riskScoringConfig = {
  weights: severityWeights,
  thresholds: riskThresholds,
  normalizeSeverity,
};

