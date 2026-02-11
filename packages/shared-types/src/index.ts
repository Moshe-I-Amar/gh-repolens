export const jobStatusValues = [
  'QUEUED',
  'FETCHING',
  'FETCHED',
  'REVIEWING',
  'COMPLETED',
  'FAILED',
] as const;

export type JobStatus = (typeof jobStatusValues)[number];

export type ReviewQuestionCategory = 'ARCH' | 'SECURITY' | 'PERFORMANCE';
export type ReviewSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO' | 'UNKNOWN';
export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type ReviewFinding = {
  path: string;
  line: number;
  reason: string;
  details: string;
  recommendation: string;
  codeSnippet: string;
};

export type ReviewAnswer = {
  id: string;
  title: string;
  category: ReviewQuestionCategory;
  severity: ReviewSeverity | string;
  answer: string;
  refs: { path: string; line?: number; endLine?: number }[];
  findings?: ReviewFinding[];
};

export type RiskSummary = {
  level: RiskLevel;
  score: number;
  counts: Record<ReviewSeverity, number>;
};

export type ReviewResults = {
  questions: ReviewAnswer[];
  riskSummary?: RiskSummary;
  reviewEngine?: 'OPENAI' | 'RULES';
};
