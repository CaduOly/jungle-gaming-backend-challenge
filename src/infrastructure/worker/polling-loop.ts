export interface PollingLoopOptions<T> {
  /** Uma unidade de trabalho. O output dela decide quanto esperar antes da próxima. */
  readonly round: () => Promise<T>;
  readonly nextDelayMs: (output: T) => number;
  /** Delay depois de uma rodada que lançou erro. */
  readonly errorDelayMs: number;
  readonly onRound?: (output: T) => unknown;
  readonly onError?: (error: unknown) => unknown;
}

/**
 * Roda as rodadas uma por vez, sem sobrepor, até ser parado. O `stop()` cancela a espera pendente e só resolve
 * depois que a rodada em andamento (se tiver) termina, aí o loop pode ser iniciado de novo.
 * Observer que lança ou rejeita é ignorado.
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

/** Um observer nunca pode parar o loop, seja lançando erro ou retornando promise rejeitada. */
const notify = (callback: () => unknown): void => {
  try {
    Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // ver acima
  }
};
