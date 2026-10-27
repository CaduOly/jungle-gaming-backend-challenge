export interface PollingLoopOptions<T> {
  /** One unit of work. Its output decides how long to wait before the next one. */
  readonly round: () => Promise<T>;
  readonly nextDelayMs: (output: T) => number;
  /** Delay after a round that threw. */
  readonly errorDelayMs: number;
  readonly onRound?: (output: T) => unknown;
  readonly onError?: (error: unknown) => unknown;
}

/**
 * Runs rounds one at a time, never overlapping, until stopped. `stop()` cancels the pending wait and
 * resolves only after the round in flight (if any) has finished; the loop can then be started again.
 * Observers that throw or reject are ignored.
 */
export class PollingLoop<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  constructor(private readonly options: PollingLoopOptions<T>) {}

  get isRunning(): boolean {
    return this.started && !this.stopping;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  start(): void {
    if (this.stopping) {
      if (this.inFlight !== undefined) throw new Error('The loop is still stopping; await stop() first');
      this.stopping = false;
      this.started = false;
    }
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = undefined;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let nextDelayMs = this.options.errorDelayMs;
    try {
      const output = await this.options.round();
      nextDelayMs = this.options.nextDelayMs(output);
      notify(() => this.options.onRound?.(output));
    } catch (error) {
      notify(() => this.options.onError?.(error));
    }
    this.schedule(nextDelayMs);
  }
}

/** An observer must never stop the loop, whether it throws or returns a rejected promise. */
const notify = (callback: () => unknown): void => {
  try {
    Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // see above
  }
};
