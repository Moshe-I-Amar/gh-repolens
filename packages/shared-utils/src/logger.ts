import pino from 'pino';

export type LoggerOptions = {
  correlationId?: string;
  level?: string;
};

// Main factory for JSON logger instances with optional correlation IDs.
export const createLogger = (options: LoggerOptions = {}) => {
  const base = options.correlationId ? { correlationId: options.correlationId } : undefined;
  return pino({
    level: options.level ?? 'info',
    base,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
};
