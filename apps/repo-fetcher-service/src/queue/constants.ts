export const JOBS_EXCHANGE = 'jobs';
export const JOBS_EXCHANGE_TYPE = 'topic';
export const JOBS_DLX = 'jobs.dlx';

export const ROUTING_KEYS = {
  jobCreated: 'job.created',
  jobFetched: 'job.fetched',
} as const;

export const QUEUES = {
  repoFetcher: 'repo_fetcher_queue',
  vibeReview: 'vibe_review_queue',
} as const;
