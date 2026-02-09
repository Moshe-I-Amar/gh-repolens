export const JOBS_EXCHANGE = 'jobs';
export const JOBS_EXCHANGE_TYPE = 'topic';
export const JOBS_DLX = 'jobs.dlx';
export const JOBS_RETRY_EXCHANGE = 'jobs.retry';

export const ROUTING_KEYS = {
  jobCreated: 'job.created',
  jobFetched: 'job.fetched',
  jobCreatedRetry: 'job.created.retry',
} as const;

export const QUEUES = {
  repoFetcher: 'repo_fetcher_queue',
  repoFetcherRetry: 'repo_fetcher_queue.retry',
  vibeReview: 'vibe_review_queue',
} as const;
