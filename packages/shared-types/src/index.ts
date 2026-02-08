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

export type ReviewAnswer = {
  id: string;
  title: string;
  category: ReviewQuestionCategory;
  severity: string;
  answer: string;
  refs: { path: string; line?: number; endLine?: number }[];
};

export type ReviewResults = {
  questions: ReviewAnswer[];
};
