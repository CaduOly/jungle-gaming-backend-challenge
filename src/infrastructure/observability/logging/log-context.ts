import { AsyncLocalStorage } from 'node:async_hooks';

/** The identifiers every log line carries while a request, a message or a worker item is being handled. */
export interface LogContext {
  correlationId?: string;
  causationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const LOG_CONTEXT_KEYS: readonly (keyof LogContext)[] = [
  'correlationId',
  'causationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
];

const storage = new AsyncLocalStorage<LogContext>();

const pick = (fields: Partial<Record<keyof LogContext, unknown>>): LogContext => {
  const picked: LogContext = {};
  for (const key of LOG_CONTEXT_KEYS) {
    const value = fields[key];
    if (typeof value === 'string' && value !== '') picked[key] = value;
  }
  return picked;
};

/** Runs `work` with a child of the current context: the outer fields stay, the given ones are added or replaced. */
export const runWithLogContext = <T>(fields: Partial<Record<keyof LogContext, unknown>>, work: () => T): T =>
  storage.run({ ...storage.getStore(), ...pick(fields) }, work);

/** Adds fields learned midway (the transaction id once the use case answers) to the context already running. */
export const bindLogContext = (fields: Partial<Record<keyof LogContext, unknown>>): void => {
  const store = storage.getStore();
  if (store !== undefined) Object.assign(store, pick(fields));
};

export const currentLogContext = (): LogContext => ({ ...storage.getStore() });
