import pino, { type DestinationStream, type Logger } from 'pino';
import { currentLogContext } from './log-context';

export type { Logger } from 'pino';

export const REDACTED = '[REDACTED]';

const MONEY_FIELDS = [
  'amount',
  'balance',
  'money',
  'initialBalance',
  'storedBalance',
  'calculatedBalance',
  'difference',
  'balanceBefore',
  'balanceAfter',
  'payload',
  'body',
];

/**
 * Money and raw payloads never reach a log line, at the top level or one or two levels down. A line that needs
 * a monetary fact logs its outcome (status, failureCode), never the value.
 */
export const REDACTED_PATHS: readonly string[] = MONEY_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]);

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export interface LoggerOptions {
  readonly level?: string;
  readonly destination?: DestinationStream;
}

/**
 * JSON logger. Every line gets the identifiers of the AsyncLocalStorage context (correlationId, messageId…)
 * through the mixin, so no call site has to pass them.
 */
export const createLogger = ({ level = 'info', destination }: LoggerOptions = {}): Logger => {
  if (!LOG_LEVELS.has(level)) throw new Error(`LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}`);
  const options = {
    level,
    base: { service: 'jungle-wagering' },
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    mixin: () => ({ ...currentLogContext() }),
    redact: { paths: [...REDACTED_PATHS], censor: REDACTED },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
};
