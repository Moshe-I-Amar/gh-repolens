import { Request, Response, NextFunction } from 'express';

import { createLogger } from '@repolens/shared-utils';

import type { CorrelationRequest } from './correlationId';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'intake-service',
});

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const correlationId = (req as CorrelationRequest).correlationId;
  logger.error(
    { correlationId, message: err.message, stack: err.stack },
    'Unhandled error',
  );
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
};
