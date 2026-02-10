import pino from 'pino';

export type LoggerOptions = {
  correlationId?: string;
  level?: string;
  service?: string;
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
