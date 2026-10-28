import type { PublishOutboxBatchOutput } from '../../../business/messaging/use-case/publish-outbox-batch/publish-outbox-batch';
import type { IUseCase } from '../../../business/shared/use-case';
import { PollingLoop } from '../../worker/polling-loop';

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
  private readonly loop: PollingLoop<PublishOutboxBatchOutput>;

  constructor(
    private readonly createRound: () => PublishOutboxRound,
    options: OutboxPublisherWorkerOptions,
  ) {
    this.loop = new PollingLoop({
      round: () => this.runOnce(),
      nextDelayMs: (output) => (output.published > 0 ? 0 : options.pollIntervalMs),
      errorDelayMs: options.pollIntervalMs,
      ...(options.onRound === undefined ? {} : { onRound: options.onRound }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
  }

  get isRunning(): boolean {
    return this.loop.isRunning;
  }

  start(): void {
    this.loop.start();
  }

  runOnce(): Promise<PublishOutboxBatchOutput> {
    return this.createRound().execute();
  }

  /** Stops polling and resolves once the round in flight, if any, has finished. */
  stop(): Promise<void> {
    return this.loop.stop();
  }
}
