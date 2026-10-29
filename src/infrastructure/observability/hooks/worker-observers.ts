import type { Logger } from '../logging/logger';
import { describeError } from '../metrics/error-classification';
import type { WageringMetrics } from '../metrics/wagering-metrics';

/** What the SQS consumer reports per settled message (its onOutcome hook). */
export interface ConsumerOutcomeEvent {
  readonly message: { readonly sqsMessageId: string; readonly receiveCount: number };
  readonly outcome:
    | { readonly kind: 'ack' }
    | { readonly kind: 'retry'; readonly delayMs?: number }
    | { readonly kind: 'dead-letter'; readonly reason: string };
  readonly durationMs: number;
}

/** What the outbox publisher reports per round (its onRound hook). */
export interface OutboxRoundReport {
  readonly published: number;
  readonly failed: number;
  readonly exhausted: number;
  readonly exhaustedMessageIds: readonly string[];
}

/** What the pending-reference worker reports per round (its onRound hook). */
export interface PendingRoundReport {
  readonly processed: number;
  readonly rejected: number;
  readonly exhausted: number;
  readonly rescheduled: number;
  readonly erroredIds: readonly string[];
}

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * The callbacks the consumer, the outbox publisher and the pending-reference worker take, turned into metrics
 * and log lines. The workers already shield themselves from a throwing observer.
 */
export class WorkerObservers {
  constructor(
    private readonly metrics: WageringMetrics,
    private readonly logger: Logger,
  ) {}

  readonly consumerOutcome = (event: ConsumerOutcomeEvent): void => {
    const { outcome } = event;
    this.metrics.processingDuration.observe({ operation: 'sqs_message', outcome: outcome.kind }, event.durationMs / 1000);
    const fields = { sqsMessageId: event.message.sqsMessageId, receiveCount: event.message.receiveCount };
    if (outcome.kind === 'retry') {
      this.metrics.retries.inc({ source: 'sqs' });
      this.logger.warn({ ...fields, delayMs: outcome.delayMs }, 'sqs message handed back for a retry');
    } else if (outcome.kind === 'dead-letter') {
      this.metrics.deadLetters.inc({ reason: outcome.reason });
      this.logger.error({ ...fields, reason: outcome.reason }, 'sqs message moved to the dead-letter queue');
    }
  };

  /** Starts the gauge at 0, so the series exists before the first state change. */
  circuitState(breaker: string): (state: BreakerState) => void {
    this.metrics.circuitBreakerOpen.set({ breaker }, 0);
    return (state) => {
      this.metrics.circuitBreakerOpen.set({ breaker }, state === 'closed' ? 0 : 1);
      this.logger.warn({ breaker, state }, `circuit breaker ${state}`);
    };
  }

  readonly outboxRound = (report: OutboxRoundReport): void => {
    if (report.failed > 0) this.metrics.retries.inc({ source: 'outbox' }, report.failed);
    if (report.exhausted > 0) {
      this.metrics.outboxAttemptsExhausted.inc(report.exhausted);
      this.logger.error({ outboxMessageIds: report.exhaustedMessageIds }, 'outbox events used up their publish attempts');
    }
  };

  readonly pendingRound = (report: PendingRoundReport): void => {
    if (report.processed > 0) this.metrics.pendingReferencesResolved.inc({ status: 'PROCESSED' }, report.processed);
    if (report.rejected > 0) this.metrics.pendingReferencesResolved.inc({ status: 'REJECTED' }, report.rejected);
    if (report.exhausted > 0) this.metrics.pendingReferencesResolved.inc({ status: 'EXHAUSTED' }, report.exhausted);
    const retried = report.rescheduled + report.erroredIds.length;
    if (retried > 0) this.metrics.retries.inc({ source: 'pending_reference' }, retried);
  };

  workerError(worker: string): (error: unknown, operation?: string) => void {
    return (error, operation) => this.logger.warn({ worker, operation, ...describeError(error) }, `${worker} round failed`);
  }
}
