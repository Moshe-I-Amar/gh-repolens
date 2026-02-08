export type JobStatus =
  | 'QUEUED'
  | 'FETCHING'
  | 'FETCHED'
  | 'REVIEWING'
  | 'COMPLETED'
  | 'FAILED';

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
