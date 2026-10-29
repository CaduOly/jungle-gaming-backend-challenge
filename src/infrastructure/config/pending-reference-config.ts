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
 * Backoff of a PENDING_REFERENCE transaction waiting for its reference; ExponentialBackoff validates the bounds.
 * The HTTP/SQS flow (first attempt) and the pending reference worker (the next ones) read the same PENDING_*
 * variables, so the two can never schedule with different policies.
 */
export const readPendingReferenceBackoff = (
  env: Readonly<Record<string, string | undefined>>,
): PendingReferenceBackoffConfig => ({
  baseMs: positive(env, 'PENDING_BACKOFF_BASE_MS', DEFAULT_PENDING_REFERENCE_BACKOFF.baseMs),
  capMs: positive(env, 'PENDING_BACKOFF_CAP_MS', DEFAULT_PENDING_REFERENCE_BACKOFF.capMs),
  maxAttempts: positive(env, 'PENDING_MAX_ATTEMPTS', DEFAULT_PENDING_REFERENCE_BACKOFF.maxAttempts),
});
