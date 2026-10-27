import { readIntegerEnv } from '../../../config/integer-env';

export interface HttpConfig {
  readonly port: number;
  /** Retry-After on a 503: how long a provider should wait before resending. */
  readonly retryAfterSeconds: number;
}

export const readHttpConfig = (env: Readonly<Record<string, string | undefined>>): HttpConfig => {
  const retryAfterSeconds = readIntegerEnv(env, 'HTTP_RETRY_AFTER_SECONDS', 2);
  if (retryAfterSeconds === 0) throw new Error('Invalid HTTP_RETRY_AFTER_SECONDS: must be at least 1');
  return { port: readIntegerEnv(env, 'PORT', 3000), retryAfterSeconds };
};
