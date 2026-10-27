import { readDatabaseUrl } from './database-url';
import { readIntegerEnv } from './integer-env';

export interface DatabaseConfig {
  readonly url: string;
  readonly lockTimeoutMs: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;

export const readDatabaseConfig = (env: Readonly<Record<string, string | undefined>>): DatabaseConfig => {
  const lockTimeoutMs = readIntegerEnv(env, 'DB_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS);
  if (lockTimeoutMs === 0) throw new Error('Invalid DB_LOCK_TIMEOUT_MS: 0 would disable the lock timeout');
  return { url: readDatabaseUrl(env), lockTimeoutMs };
};
