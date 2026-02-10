import { z } from 'zod';

export const reviewQuestionCategorySchema = z.enum(['ARCH', 'SECURITY', 'PERFORMANCE']);

export const reviewQuestionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: reviewQuestionCategorySchema,
  prompt: z.string().min(1),
});

export const reviewQuestionsSchema = z.array(reviewQuestionSchema).min(1);

export const reviewSeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN']);
export const riskLevelSchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE']);

export const reviewRefSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

export const reviewAnswerSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: reviewQuestionCategorySchema,
  severity: z.string().min(1),
  answer: z.string().min(1),
  refs: z.array(reviewRefSchema),
});

export const riskCountsSchema = z.object({
  CRITICAL: z.number().int().nonnegative(),
  HIGH: z.number().int().nonnegative(),
  MEDIUM: z.number().int().nonnegative(),
  LOW: z.number().int().nonnegative(),
  INFO: z.number().int().nonnegative(),
  UNKNOWN: z.number().int().nonnegative(),
});

export const riskSummarySchema = z.object({
  level: riskLevelSchema,
  score: z.number().nonnegative(),
  counts: riskCountsSchema,
});

export const reviewResultsSchema = z.object({
  questions: z.array(reviewAnswerSchema),
  riskSummary: riskSummarySchema.optional(),
});

export const jobFetchedPayloadSchema = z.object({
  jobId: z.string().min(1),
  localPath: z.string().optional(),
});

