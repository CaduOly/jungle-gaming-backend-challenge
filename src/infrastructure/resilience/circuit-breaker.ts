import type { IClock } from '../../business/shared/port/clock.port';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Falhas consecutivas que abrem um circuito fechado. */
  readonly failureThreshold: number;
  /** Quanto tempo um circuito aberto recusa trabalho antes de deixar passar uma tentativa (half-open). */
  readonly openMs: number;
  readonly clock: IClock;
  readonly onStateChange?: (state: CircuitState) => void;
}

/**
 * closed → (failureThreshold falhas consecutivas) → open → (openMs) → half-open → sucesso: closed,
 * falha: open de novo. O half-open é derivado do clock, então nada precisa ficar fazendo tick.
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

  /** Exposto como o gauge circuit_breaker_open. Half-open conta como open, já que o trabalho ainda fica segurado. */
  get isOpen(): boolean {
    return this.state !== 'closed';
  }

  canAttempt(): boolean {
    return this.report(this.state) !== 'open';
  }

  /** Milissegundos até um circuito aberto virar half-open (0 quando já deixa passar uma tentativa). */
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
        // Um observer nunca pode quebrar o breaker.
      }
    }
    return state;
  }
}
