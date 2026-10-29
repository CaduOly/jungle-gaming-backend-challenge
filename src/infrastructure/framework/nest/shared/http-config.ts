import { readIntegerEnv } from '../../../config/integer-env';

export interface HttpConfig {
  readonly port: number;
  /** Retry-After on a 503: how long a provider should wait before resending. */
  readonly retryAfterSeconds: number;
  /** Upper bound for each readiness check, so a hung dependency answers "down" before the probe gives up. */
  readonly readinessTimeoutMs: number;
  /** Largest JSON body the parser reads (`512b`, `100kb`, `1mb`); anything above answers 413. */
  readonly bodyLimit: string;
}

const readBodyLimit = (env: Readonly<Record<string, string | undefined>>): string => {
  const raw = env.HTTP_BODY_LIMIT;
  if (raw === undefined || raw === '') return '100kb';
  if (!/^[1-9]\d{0,8}(b|kb|mb)$/i.test(raw)) {
    throw new Error(`Invalid HTTP_BODY_LIMIT: "${raw}" (a positive integer followed by b, kb or mb)`);
  }
  return raw;
};

export const readHttpConfig = (env: Readonly<Record<string, string | undefined>>): HttpConfig => {
  const retryAfterSeconds = readIntegerEnv(env, 'HTTP_RETRY_AFTER_SECONDS', 2);
  if (retryAfterSeconds === 0) throw new Error('Invalid HTTP_RETRY_AFTER_SECONDS: must be at least 1');
  const readinessTimeoutMs = readIntegerEnv(env, 'HEALTH_READINESS_TIMEOUT_MS', 1_000);
  if (readinessTimeoutMs === 0) throw new Error('Invalid HEALTH_READINESS_TIMEOUT_MS: must be at least 1');
  return {
    port: readIntegerEnv(env, 'PORT', 3000),
    retryAfterSeconds,
    readinessTimeoutMs,
    bodyLimit: readBodyLimit(env),
  };
};
