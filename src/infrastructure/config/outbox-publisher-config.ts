import { readIntegerEnv } from './integer-env';

type Env = Readonly<Record<string, string | undefined>>;

export interface OutboxPublisherConfig {
  readonly leaseMs: number;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  /** Upper bound for one publish; the factory enforces it whatever the publisher does. */
  readonly publishTimeoutMs: number;
  readonly backoff: {
    readonly baseMs: number;
    readonly capMs: number;
    readonly maxAttempts: number;
  };
}

export const DEFAULT_OUTBOX_PUBLISHER_CONFIG: OutboxPublisherConfig = {
  leaseMs: 30_000,
  batchSize: 10,
  pollIntervalMs: 200,
  publishTimeoutMs: 2_000,
  backoff: { baseMs: 500, capMs: 60_000, maxAttempts: 10 },
};

const positive = (env: Env, name: string, fallback: number): number => {
  const value = readIntegerEnv(env, name, fallback);
  if (value === 0) throw new Error(`Invalid ${name}: must be at least 1`);
  return value;
};

/**
 * A round publishes its batch one message at a time, so the lease must outlive batchSize publishes at their
 * timeout: otherwise another instance reclaims (and republishes) messages this one is still working on.
 * The backoff values are validated again (cap bounds) by ExponentialBackoff itself.
 */
export const validateOutboxPublisherConfig = (config: OutboxPublisherConfig): OutboxPublisherConfig => {
  const worstRoundMs = config.batchSize * config.publishTimeoutMs;
  if (config.leaseMs <= worstRoundMs) {
    throw new Error(
      `Invalid OUTBOX_LEASE_MS: ${config.leaseMs}ms must exceed OUTBOX_BATCH_SIZE x OUTBOX_PUBLISH_TIMEOUT_MS (${worstRoundMs}ms)`,
    );
  }
  return config;
};

export const readOutboxPublisherConfig = (env: Env): OutboxPublisherConfig => {
  const defaults = DEFAULT_OUTBOX_PUBLISHER_CONFIG;
  return validateOutboxPublisherConfig({
    leaseMs: positive(env, 'OUTBOX_LEASE_MS', defaults.leaseMs),
    batchSize: positive(env, 'OUTBOX_BATCH_SIZE', defaults.batchSize),
    pollIntervalMs: positive(env, 'OUTBOX_POLL_INTERVAL_MS', defaults.pollIntervalMs),
    publishTimeoutMs: positive(env, 'OUTBOX_PUBLISH_TIMEOUT_MS', defaults.publishTimeoutMs),
    backoff: {
      baseMs: positive(env, 'OUTBOX_BACKOFF_BASE_MS', defaults.backoff.baseMs),
      capMs: positive(env, 'OUTBOX_BACKOFF_CAP_MS', defaults.backoff.capMs),
      maxAttempts: positive(env, 'OUTBOX_MAX_ATTEMPTS', defaults.backoff.maxAttempts),
    },
  });
};
