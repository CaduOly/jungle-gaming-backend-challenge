import { InvalidBackoffConfigurationError } from '../error/invalid-backoff-configuration-error';

export const MAX_BACKOFF_CAP_MS = 24 * 60 * 60 * 1_000;

export interface ExponentialBackoffOptions {
  readonly baseMs: number;
  readonly capMs: number;
  readonly maxAttempts: number;
  /** Uniform source in [0, 1). Injected so the jitter is deterministic under test. */
  readonly random: () => number;
}

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/**
 * Equal jitter: the delay for attempt n is uniform in [w/2, w), where w = min(cap, base * 2^(n-1)).
 * Keeps retries spread across instances without ever collapsing to an immediate retry (minimum 1ms).
 */
export class ExponentialBackoff {
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly random: () => number;
  readonly maxAttempts: number;

  constructor(options: ExponentialBackoffOptions) {
    if (!isPositiveInteger(options.baseMs)) throw new InvalidBackoffConfigurationError('baseMs must be a positive integer');
    if (!isPositiveInteger(options.capMs) || options.capMs < options.baseMs || options.capMs > MAX_BACKOFF_CAP_MS) {
      throw new InvalidBackoffConfigurationError(`capMs must be an integer between baseMs and ${MAX_BACKOFF_CAP_MS}`);
    }
    if (!isPositiveInteger(options.maxAttempts)) {
      throw new InvalidBackoffConfigurationError('maxAttempts must be a positive integer');
    }
    this.baseMs = options.baseMs;
    this.capMs = options.capMs;
    this.maxAttempts = options.maxAttempts;
    this.random = options.random;
  }

  nextDelayMs(attempt: number): number {
    if (!isPositiveInteger(attempt)) throw new InvalidBackoffConfigurationError('attempt must be a positive integer');
    const sample = this.random();
    if (!(sample >= 0 && sample < 1)) throw new InvalidBackoffConfigurationError('random must return a value in [0, 1)');
    const window = Math.min(this.capMs, this.baseMs * 2 ** (attempt - 1));
    const half = window / 2;
    return Math.max(1, Math.floor(half + sample * half));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}
