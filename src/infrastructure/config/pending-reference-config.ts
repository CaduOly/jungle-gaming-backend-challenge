import { readIntegerEnv } from './integer-env';

export interface PendingReferenceBackoffConfig {
  readonly baseMs: number;
  readonly capMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_PENDING_REFERENCE_BACKOFF: PendingReferenceBackoffConfig = {
  baseMs: 2_000,
  capMs: 60_000,
  maxAttempts: 8,
};

const positive = (env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number => {
  const value = readIntegerEnv(env, name, fallback);
  if (value === 0) throw new Error(`Invalid ${name}: must be at least 1`);
  return value;
};

/**
 * Backoff de uma transação PENDING_REFERENCE esperando a referência dela, os limites são validados pelo
 * ExponentialBackoff. O fluxo HTTP/SQS (primeira tentativa) e o pending reference worker (as próximas) leem as
 * mesmas variáveis PENDING_*, então os dois nunca agendam com políticas diferentes.
 */
export const readPendingReferenceBackoff = (
  env: Readonly<Record<string, string | undefined>>,
): PendingReferenceBackoffConfig => ({
  baseMs: positive(env, 'PENDING_BACKOFF_BASE_MS', DEFAULT_PENDING_REFERENCE_BACKOFF.baseMs),
  capMs: positive(env, 'PENDING_BACKOFF_CAP_MS', DEFAULT_PENDING_REFERENCE_BACKOFF.capMs),
  maxAttempts: positive(env, 'PENDING_MAX_ATTEMPTS', DEFAULT_PENDING_REFERENCE_BACKOFF.maxAttempts),
});
