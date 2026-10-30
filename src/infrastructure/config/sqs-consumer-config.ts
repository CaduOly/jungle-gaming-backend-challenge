import { readIntegerEnv } from './integer-env';

type Env = Readonly<Record<string, string | undefined>>;

export interface SqsConsumerConfig {
  readonly waitTimeSeconds: number;
  readonly maxMessages: number;
  readonly visibilityTimeoutSeconds: number;
  readonly heartbeatIntervalMs: number;
  /**
   * Limite de retry: falhas consecutivas da própria mensagem, retentadas dentro do processo (backoff + heartbeat),
   * antes de ir para a DLQ como retries_exhausted. Não é o maxReceiveCount do redrive da fila, que conta entregas e
   * tem que ficar bem acima disso (ver SqsConsumerLoop).
   */
  readonly maxInProcessAttempts: number;
  readonly retry: { readonly baseMs: number; readonly capMs: number };
  /** Espera depois de um readiness probe ou de um receive que falhou. */
  readonly errorDelayMs: number;
  readonly shutdownTimeoutMs: number;
  /** Limite de uma tentativa do handler, passou disso a tentativa conta como falha transiente (ver TimeoutMessageHandler). */
  readonly handlerTimeoutMs: number;
  readonly circuitBreaker: { readonly failureThreshold: number; readonly openMs: number };
}

export const DEFAULT_SQS_CONSUMER_CONFIG: SqsConsumerConfig = {
  waitTimeSeconds: 20,
  maxMessages: 10,
  visibilityTimeoutSeconds: 30,
  heartbeatIntervalMs: 10_000,
  maxInProcessAttempts: 8,
  retry: { baseMs: 1_000, capMs: 60_000 },
  errorDelayMs: 1_000,
  shutdownTimeoutMs: 25_000,
  handlerTimeoutMs: 15_000,
  circuitBreaker: { failureThreshold: 3, openMs: 5_000 },
};

const MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;

const bounded = (env: Env, name: string, fallback: number, min: number, max: number): number => {
  const value = readIntegerEnv(env, name, fallback);
  if (value < min || value > max) throw new Error(`Invalid ${name}: must be between ${min} and ${max}`);
  return value;
};

const positive = (env: Env, name: string, fallback: number): number =>
  bounded(env, name, fallback, 1, Number.MAX_SAFE_INTEGER);

export const readSqsConsumerConfig = (env: Env): SqsConsumerConfig => {
  const d = DEFAULT_SQS_CONSUMER_CONFIG;
  const visibilityTimeoutSeconds = bounded(
    env,
    'SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS',
    d.visibilityTimeoutSeconds,
    1,
    MAX_VISIBILITY_TIMEOUT_SECONDS,
  );
  const heartbeatIntervalMs = positive(env, 'SQS_CONSUMER_HEARTBEAT_INTERVAL_MS', d.heartbeatIntervalMs);
  if (heartbeatIntervalMs >= visibilityTimeoutSeconds * 1_000) {
    throw new Error('Invalid SQS_CONSUMER_HEARTBEAT_INTERVAL_MS: must be shorter than the visibility timeout');
  }
  return {
    waitTimeSeconds: bounded(env, 'SQS_CONSUMER_WAIT_TIME_SECONDS', d.waitTimeSeconds, 0, 20),
    maxMessages: bounded(env, 'SQS_CONSUMER_MAX_MESSAGES', d.maxMessages, 1, 10),
    visibilityTimeoutSeconds,
    heartbeatIntervalMs,
    maxInProcessAttempts: positive(env, 'SQS_CONSUMER_MAX_IN_PROCESS_ATTEMPTS', d.maxInProcessAttempts),
    retry: {
      baseMs: positive(env, 'SQS_CONSUMER_RETRY_BASE_MS', d.retry.baseMs),
      capMs: positive(env, 'SQS_CONSUMER_RETRY_CAP_MS', d.retry.capMs),
    },
    errorDelayMs: positive(env, 'SQS_CONSUMER_ERROR_DELAY_MS', d.errorDelayMs),
    shutdownTimeoutMs: positive(env, 'SHUTDOWN_TIMEOUT_MS', d.shutdownTimeoutMs),
    handlerTimeoutMs: positive(env, 'SQS_CONSUMER_HANDLER_TIMEOUT_MS', d.handlerTimeoutMs),
    circuitBreaker: {
      failureThreshold: positive(env, 'CIRCUIT_BREAKER_FAILURE_THRESHOLD', d.circuitBreaker.failureThreshold),
      openMs: positive(env, 'CIRCUIT_BREAKER_OPEN_MS', d.circuitBreaker.openMs),
    },
  };
};
