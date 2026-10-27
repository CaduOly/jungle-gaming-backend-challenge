import { readDatabaseUrl } from './database-url';
import { readIntegerEnv } from './integer-env';

export interface DatabaseConfig {
  readonly url: string;
  readonly lockTimeoutMs: number;
  /** How long to wait for a pooled connection before failing with a transient error. */
  readonly poolAcquireTimeoutMs: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
export const DEFAULT_POOL_ACQUIRE_TIMEOUT_MS = 5_000;

export const readDatabaseConfig = (env: Readonly<Record<string, string | undefined>>): DatabaseConfig => {
  const lockTimeoutMs = readIntegerEnv(env, 'DB_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS);
  if (lockTimeoutMs === 0) throw new Error('Invalid DB_LOCK_TIMEOUT_MS: 0 would disable the lock timeout');
  const poolAcquireTimeoutMs = readIntegerEnv(env, 'DB_POOL_ACQUIRE_TIMEOUT_MS', DEFAULT_POOL_ACQUIRE_TIMEOUT_MS);
  if (poolAcquireTimeoutMs === 0) {
    throw new Error('Invalid DB_POOL_ACQUIRE_TIMEOUT_MS: 0 would let an exhausted pool hang forever');
  }
  return { url: readDatabaseUrl(env), lockTimeoutMs, poolAcquireTimeoutMs };
};
