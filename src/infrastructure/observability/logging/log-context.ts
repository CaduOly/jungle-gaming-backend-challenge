import { AsyncLocalStorage } from 'node:async_hooks';

/** Os identificadores que toda linha de log carrega enquanto uma request, uma mensagem ou um item do worker está sendo tratado. */
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

/** Roda `work` com um filho do contexto atual: os campos de fora ficam, os passados são adicionados ou substituídos. */
export const runWithLogContext = <T>(fields: Partial<Record<keyof LogContext, unknown>>, work: () => T): T =>
  storage.run({ ...storage.getStore(), ...pick(fields) }, work);

/** Adiciona campos descobertos no meio do caminho (o id da transação quando o use case responde) ao contexto já rodando. */
export const bindLogContext = (fields: Partial<Record<keyof LogContext, unknown>>): void => {
  const store = storage.getStore();
  if (store !== undefined) Object.assign(store, pick(fields));
};

export const currentLogContext = (): LogContext => ({ ...storage.getStore() });
