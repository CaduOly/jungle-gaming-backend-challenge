import { MAX_BACKOFF_CAP_MS } from '../../business/shared/policy/exponential-backoff';
import { readIntegerEnv } from './integer-env';

type Env = Readonly<Record<string, string | undefined>>;

export interface PendingReferenceWorkerConfig {
  readonly batchSize: number;
  readonly leaseMs: number;
  /** Wait after a round that did not fill its batch (nothing else is due yet) or that threw. */
  readonly pollIntervalMs: number;
  readonly backoff: {
    readonly baseMs: number;
    readonly capMs: number;
    readonly maxAttempts: number;
  };
}

/** base 2s, cap 60s, 8 attempts: about five minutes before REFERENCE_NOT_FOUND. */
export const DEFAULT_PENDING_REFERENCE_WORKER_CONFIG: PendingReferenceWorkerConfig = {
  batchSize: 10,
  leaseMs: 60_000,
  pollIntervalMs: 1_000,
  backoff: { baseMs: 2_000, capMs: 60_000, maxAttempts: 8 },
};

const positive = (env: Env, name: string, fallback: number): number => {
  const value = readIntegerEnv(env, name, fallback);
  if (value === 0) throw new Error(`Invalid ${name}: must be at least 1`);
  return value;
};

/**
 * Each item of a round may wait out the lock timeout twice (wallet, then transaction), so the lease must outlive
 * that whole batch: otherwise another instance reclaims items this one has not reached yet. That only wastes work
 * (the use case skips an attempt that was already counted), but a lease that is always too short makes it the rule.
 */
export const validatePendingReferenceWorkerConfig = (
  config: PendingReferenceWorkerConfig,
  { lockTimeoutMs }: { readonly lockTimeoutMs: number },
): PendingReferenceWorkerConfig => {
  const { baseMs, capMs } = config.backoff;
  if (capMs < baseMs || capMs > MAX_BACKOFF_CAP_MS) {
    throw new Error(
      `Invalid PENDING_BACKOFF_CAP_MS: ${capMs}ms must be between PENDING_BACKOFF_BASE_MS (${baseMs}ms) and ${MAX_BACKOFF_CAP_MS}ms`,
    );
  }
  const worstRoundMs = config.batchSize * 2 * lockTimeoutMs;
  if (config.leaseMs <= worstRoundMs) {
    throw new Error(
      `Invalid PENDING_LEASE_MS: ${config.leaseMs}ms must exceed PENDING_BATCH_SIZE x 2 x DB_LOCK_TIMEOUT_MS (${worstRoundMs}ms)`,
    );
  }
  return config;
};

export const readPendingReferenceWorkerConfig = (
  env: Env,
  database: { readonly lockTimeoutMs: number },
): PendingReferenceWorkerConfig => {
  const defaults = DEFAULT_PENDING_REFERENCE_WORKER_CONFIG;
  return validatePendingReferenceWorkerConfig(
    {
      batchSize: positive(env, 'PENDING_BATCH_SIZE', defaults.batchSize),
      leaseMs: positive(env, 'PENDING_LEASE_MS', defaults.leaseMs),
      pollIntervalMs: positive(env, 'PENDING_POLL_INTERVAL_MS', defaults.pollIntervalMs),
      backoff: {
        baseMs: positive(env, 'PENDING_BACKOFF_BASE_MS', defaults.backoff.baseMs),
        capMs: positive(env, 'PENDING_BACKOFF_CAP_MS', defaults.backoff.capMs),
        maxAttempts: positive(env, 'PENDING_MAX_ATTEMPTS', defaults.backoff.maxAttempts),
      },
    },
    database,
  );
};
