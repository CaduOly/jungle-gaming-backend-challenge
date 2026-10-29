import type { IClock } from '../../business/shared/port/clock.port';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open a closed circuit. */
  readonly failureThreshold: number;
  /** How long an open circuit refuses work before letting one trial through (half-open). */
  readonly openMs: number;
  readonly clock: IClock;
  readonly onStateChange?: (state: CircuitState) => void;
}

/**
 * closed → (failureThreshold consecutive failures) → open → (openMs) → half-open → success: closed,
 * failure: open again. Half-open is derived from the clock, so nothing has to tick.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private lastReported: CircuitState = 'closed';

  constructor(private readonly options: CircuitBreakerOptions) {
    if (!Number.isSafeInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new Error('failureThreshold must be a positive integer');
    }
    if (!Number.isSafeInteger(options.openMs) || options.openMs < 1) throw new Error('openMs must be a positive integer');
  }

  get state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    return this.options.clock.now().getTime() - this.openedAt >= this.options.openMs ? 'half-open' : 'open';
  }

  /** Exposed as the circuit_breaker_open gauge (T11). Half-open counts as open: work is still held back. */
  get isOpen(): boolean {
    return this.state !== 'closed';
  }

  canAttempt(): boolean {
    return this.report(this.state) !== 'open';
  }

  /** Milliseconds until an open circuit turns half-open (0 when it already allows a trial). */
  remainingOpenMs(): number {
    if (this.openedAt === undefined) return 0;
    return Math.max(0, this.openedAt + this.options.openMs - this.options.clock.now().getTime());
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.report('closed');
  }

  recordFailure(): void {
    const state = this.state;
    this.failures += 1;
    if (state === 'half-open' || (state === 'closed' && this.failures >= this.options.failureThreshold)) {
      this.openedAt = this.options.clock.now().getTime();
    }
    this.report(this.state);
  }

  private report(state: CircuitState): CircuitState {
    if (state !== this.lastReported) {
      this.lastReported = state;
      try {
        this.options.onStateChange?.(state);
      } catch {
        // An observer must never break the breaker.
      }
    }
    return state;
  }
}
