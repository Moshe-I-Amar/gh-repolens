import mongoose, { Document, Schema } from 'mongoose';

import { jobStatusValues, JobStatus, ReviewResults } from '@repolens/shared-types';
import { isValidGithubRepoUrl } from '@repolens/shared-utils';

export type JobDocument = Document & {
  repoUrl: string;
  status: JobStatus;
  localPath?: string | null;
  reviewResults?: ReviewResults | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const reviewRefSchema = new Schema(
  {
    path: { type: String, required: true },
    line: { type: Number, required: false },
    endLine: { type: Number, required: false },
  },
  { _id: false },
);

const reviewFindingSchema = new Schema(
  {
    path: { type: String, required: true },
    line: { type: Number, required: true },
    endLine: { type: Number, required: false },
    reason: { type: String, required: true },
    details: { type: String, required: true },
    recommendation: { type: String, required: true },
    codeSnippet: { type: String, required: true },
  },
  { _id: false },
);

const reviewAnswerSchema = new Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    category: { type: String, required: true },
    severity: { type: String, required: true },
    answer: { type: String, required: true },
    reviewEngine: { type: String, enum: ['OPENAI', 'RULES'], required: false },
    reviewModel: { type: String, required: false },
    reviewStatus: { type: String, enum: ['OK', 'FALLBACK', 'ERROR'], required: false },
    refs: { type: [reviewRefSchema], default: [] },
    findings: { type: [reviewFindingSchema], required: false },
  },
  { _id: false },
);

const riskSummarySchema = new Schema(
  {
    level: { type: String, required: true },
    score: { type: Number, required: true },
    counts: {
      CRITICAL: { type: Number, default: 0 },
      HIGH: { type: Number, default: 0 },
      MEDIUM: { type: Number, default: 0 },
      LOW: { type: Number, default: 0 },
      INFO: { type: Number, default: 0 },
      UNKNOWN: { type: Number, default: 0 },
    },
  },
  { _id: false },
);

const reviewResultsSchema = new Schema(
  {
    questions: { type: [reviewAnswerSchema], default: [] },
    riskSummary: { type: riskSummarySchema, required: false },
    reviewEngine: { type: String, enum: ['OPENAI', 'RULES'], required: false },
  },
  { _id: false },
);

// TODO: Schema duplication across services risks drift; consider centralizing when refactoring.
const jobSchema = new Schema<JobDocument>(
  {
    repoUrl: {
      type: String,
      required: true,
      validate: {
        validator: isValidGithubRepoUrl,
        message: 'Invalid GitHub repo URL',
      },
    },
    status: {
      type: String,
      enum: jobStatusValues,
      required: true,
    },
    localPath: {
      type: String,
      default: null,
    },
    reviewResults: {
      type: reviewResultsSchema,
      default: null,
    },
    error: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

jobSchema.index({ status: 1 });
jobSchema.index({ createdAt: -1 });
jobSchema.index({ updatedAt: -1 });

export const JobModel =
  (mongoose.models.Job as mongoose.Model<JobDocument>) ||
  mongoose.model<JobDocument>('Job', jobSchema);
