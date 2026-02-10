import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

import { createLogger } from '@repolens/shared-utils';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  service: 'intake-service',
});

export type CorrelationRequest = Request & { correlationId?: string };

export const correlationIdMiddleware = (
  req: CorrelationRequest,
  res: Response,
  next: NextFunction,
) => {
  const headerId = req.header('x-correlation-id');
  const correlationId = headerId && headerId.length > 0 ? headerId : crypto.randomUUID();

  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);
  logger.info({ correlationId, path: req.path, method: req.method }, 'Request received');
  next();
};
