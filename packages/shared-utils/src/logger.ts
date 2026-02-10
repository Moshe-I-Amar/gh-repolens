import pino from 'pino';

export type LoggerOptions = {
  correlationId?: string;
  level?: string;
  service?: string;
};

export type LogLevel = 'info' | 'warn' | 'error';
export type JobLogParams = {
  jobId: string;
  stage: string;
  message: string;
  level?: LogLevel;
  fields?: Record<string, unknown>;
};
type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// Main factory for JSON logger instances with optional correlation IDs.
export const createLogger = (options: LoggerOptions = {}) => {
  const base = {
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.service ? { service: options.service } : {}),
  };
  return pino({
    level: options.level ?? 'info',
    base: Object.keys(base).length > 0 ? base : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
};

// Standardizes job lifecycle events with shared fields for correlation.
export const logJobEvent = (logger: LoggerLike, params: JobLogParams) => {
  const level = params.level ?? 'info';
  const payload = {
    jobId: params.jobId,
    stage: params.stage,
    ...(params.fields ?? {}),
  };
  logger[level](payload, params.message);
};
