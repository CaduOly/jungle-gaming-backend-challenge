import type { Logger } from '../logging/logger';
import { describeError } from '../metrics/error-classification';
import type { WageringMetrics } from '../metrics/wagering-metrics';

/** O que o consumer SQS reporta por mensagem settled (o hook onOutcome dele). */
export interface ConsumerOutcomeEvent {
  readonly message: { readonly sqsMessageId: string; readonly receiveCount: number };
  readonly outcome:
    | { readonly kind: 'ack' }
    | { readonly kind: 'retry'; readonly delayMs?: number }
    | { readonly kind: 'dead-letter'; readonly reason: string };
  readonly durationMs: number;
}

/** O que o outbox publisher reporta por rodada (o hook onRound dele). */
export interface OutboxRoundReport {
  readonly published: number;
  readonly failed: number;
  readonly exhausted: number;
  readonly exhaustedMessageIds: readonly string[];
}

/** O que o pending-reference worker reporta por rodada (o hook onRound dele). */
export interface PendingRoundReport {
  readonly processed: number;
  readonly rejected: number;
  readonly exhausted: number;
  readonly rescheduled: number;
  readonly erroredIds: readonly string[];
}

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Os callbacks que o consumer, o outbox publisher e o pending-reference worker recebem, transformados em métricas
 * e linhas de log. Os workers já se protegem de observer que lança erro.
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

  /** Começa o gauge em 0, assim a série existe antes da primeira mudança de estado. */
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
