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
 * Dinheiro e payload cru nunca chegam numa linha de log, nem no primeiro nível nem um ou dois níveis abaixo. Linha
 * que precisa de um fato monetário loga o outcome (status, failureCode), nunca o valor.
 */
export const REDACTED_PATHS: readonly string[] = MONEY_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]);

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export interface LoggerOptions {
  readonly level?: string;
  readonly destination?: DestinationStream;
}

/**
 * Logger JSON. Toda linha recebe os identificadores do contexto do AsyncLocalStorage (correlationId, messageId…)
 * pelo mixin, então nenhum ponto de chamada precisa passar eles.
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
