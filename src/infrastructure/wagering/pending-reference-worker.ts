import type { IUseCase } from '../../business/shared/use-case';
import type { RetryPendingReferencesOutput } from '../../business/wagering/use-case/retry-pending-references/retry-pending-references';
import { PollingLoop } from '../worker/polling-loop';

export type RetryPendingRound = IUseCase<void, RetryPendingReferencesOutput>;

export interface PendingReferenceWorkerOptions {
  /** A round that claimed this many items may have left more due ones behind, so the next starts right away. */
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  /** Output of every finished round; the hook the metrics decorator (T11) plugs into. */
  readonly onRound?: (output: RetryPendingReferencesOutput) => unknown;
  /** A round that threw (the claim itself failed, database down for instance). The loop keeps going. */
  readonly onError?: (error: unknown) => unknown;
}

/**
 * Runs RetryPendingReferences one round at a time. A full batch is followed right away by the next round to drain
 * the backlog; a partial or failing one waits for the poll interval, since nothing else is due yet. After `stop()`
 * resolves the worker can be started again; starting it while a stop is still waiting for its round throws.
 */
export class PendingReferenceWorker {
  private readonly loop: PollingLoop<RetryPendingReferencesOutput>;

  constructor(
    private readonly round: RetryPendingRound,
    options: PendingReferenceWorkerOptions,
  ) {
    this.loop = new PollingLoop({
      round: () => this.runOnce(),
      nextDelayMs: (output) => (output.claimed >= options.batchSize ? 0 : options.pollIntervalMs),
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

  runOnce(): Promise<RetryPendingReferencesOutput> {
    return this.round.execute();
  }

  /** Stops polling and resolves once the round in flight, if any, has finished. */
  stop(): Promise<void> {
    return this.loop.stop();
  }
}
