import { readIntegerEnv } from './integer-env';

type Env = Readonly<Record<string, string | undefined>>;

export interface OutboxPublisherConfig {
  readonly leaseMs: number;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly backoff: {
    readonly baseMs: number;
    readonly capMs: number;
    readonly maxAttempts: number;
  };
}

export const DEFAULT_OUTBOX_PUBLISHER_CONFIG: OutboxPublisherConfig = {
  leaseMs: 30_000,
  batchSize: 50,
  pollIntervalMs: 200,
  backoff: { baseMs: 500, capMs: 60_000, maxAttempts: 10 },
};

const positive = (env: Env, name: string, fallback: number): number => {
  const value = readIntegerEnv(env, name, fallback);
  if (value === 0) throw new Error(`Invalid ${name}: must be at least 1`);
  return value;
};

/** The backoff values are validated again (cap bounds) by ExponentialBackoff itself. */
export const readOutboxPublisherConfig = (env: Env): OutboxPublisherConfig => {
  const defaults = DEFAULT_OUTBOX_PUBLISHER_CONFIG;
  return {
    leaseMs: positive(env, 'OUTBOX_LEASE_MS', defaults.leaseMs),
    batchSize: positive(env, 'OUTBOX_BATCH_SIZE', defaults.batchSize),
    pollIntervalMs: positive(env, 'OUTBOX_POLL_INTERVAL_MS', defaults.pollIntervalMs),
    backoff: {
      baseMs: positive(env, 'OUTBOX_BACKOFF_BASE_MS', defaults.backoff.baseMs),
      capMs: positive(env, 'OUTBOX_BACKOFF_CAP_MS', defaults.backoff.capMs),
      maxAttempts: positive(env, 'OUTBOX_MAX_ATTEMPTS', defaults.backoff.maxAttempts),
    },
  };
};
