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
      type: Schema.Types.Mixed,
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

export const JobModel =
  (mongoose.models.Job as mongoose.Model<JobDocument>) ||
  mongoose.model<JobDocument>('Job', jobSchema);
