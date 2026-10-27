import type { PublishOutboxBatchOutput } from '../../../business/messaging/use-case/publish-outbox-batch/publish-outbox-batch';
import type { IUseCase } from '../../../business/shared/use-case';

export type PublishOutboxRound = IUseCase<void, PublishOutboxBatchOutput>;

export interface OutboxPublisherWorkerOptions {
  readonly pollIntervalMs: number;
  /** Output of every finished round; the hook the metrics decorator (T11) plugs into. */
  readonly onRound?: (output: PublishOutboxBatchOutput) => unknown;
  /** A round that threw (database down, for instance). The loop keeps going after the poll interval. */
  readonly onError?: (error: unknown) => unknown;
}

/**
 * Polls the outbox, one round at a time. A round that published something is followed right away by the
 * next one, to drain a backlog; an empty or failing round waits for the poll interval. `createRound` is
 * called per round so every round gets a fresh EntityManager fork. After `stop()` resolves the worker can be
 * started again; starting it while a stop is still waiting for its round throws.
 */
export class OutboxPublisherWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  constructor(
    private readonly createRound: () => PublishOutboxRound,
    private readonly options: OutboxPublisherWorkerOptions,
  ) {}

  get isRunning(): boolean {
    return this.started && !this.stopping;
  }

  start(): void {
    if (this.stopping) {
      if (this.inFlight !== undefined) throw new Error('OutboxPublisherWorker is still stopping; await stop() first');
      this.stopping = false;
      this.started = false;
    }
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  runOnce(): Promise<PublishOutboxBatchOutput> {
    return this.createRound().execute();
  }

  /** Stops polling and resolves once the round in flight, if any, has finished. */
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
    let nextDelayMs = this.options.pollIntervalMs;
    try {
      const output = await this.runOnce();
      if (output.published > 0) nextDelayMs = 0;
      this.notify(() => this.options.onRound?.(output));
    } catch (error) {
      this.notify(() => this.options.onError?.(error));
    }
    this.schedule(nextDelayMs);
  }

  /** An observer must never stop the publisher, whether it throws or returns a rejected promise. */
  private notify(callback: () => unknown): void {
    try {
      Promise.resolve(callback()).catch(() => undefined);
    } catch {
      // see above
    }
  }
}
