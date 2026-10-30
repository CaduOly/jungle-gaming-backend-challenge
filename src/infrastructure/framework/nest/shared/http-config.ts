import { readIntegerEnv } from '../../../config/integer-env';

export interface HttpConfig {
  readonly port: number;
  /** Retry-After no 503: quanto tempo o provider deve esperar antes de reenviar. */
  readonly retryAfterSeconds: number;
  /** Limite de cada readiness check, assim uma dependência travada responde "down" antes do probe desistir. */
  readonly readinessTimeoutMs: number;
  /** Maior body JSON que o parser lê (`512b`, `100kb`, `1mb`), acima disso responde 413. */
  readonly bodyLimit: string;
  /**
   * Limite de uma request. Passou disso a resposta é 503 + Retry-After, então um banco que para de responder
   * (pausado, particionado) nunca deixa o provider pendurado, e o retry é seguro já que toda escrita é idempotente.
   */
  readonly requestTimeoutMs: number;
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
  const requestTimeoutMs = readIntegerEnv(env, 'HTTP_REQUEST_TIMEOUT_MS', 10_000);
  if (requestTimeoutMs === 0) throw new Error('Invalid HTTP_REQUEST_TIMEOUT_MS: must be at least 1');
  return {
    port: readIntegerEnv(env, 'PORT', 3000),
    retryAfterSeconds,
    readinessTimeoutMs,
    bodyLimit: readBodyLimit(env),
    requestTimeoutMs,
  };
};
