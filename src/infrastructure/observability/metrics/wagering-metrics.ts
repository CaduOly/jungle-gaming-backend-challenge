import { Counter, Gauge, Histogram, Registry } from 'prom-client';

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LAG_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

export const METRIC_NAMES = [
  'wager_transactions_total',
  'idempotent_duplicates_total',
  'retries_total',
  'dlq_messages_total',
  'lock_conflicts_total',
  'lock_wait_seconds',
  'outbox_lag_seconds',
  'outbox_attempts_exhausted_total',
  'processing_duration_seconds',
  'reconciliation_divergences_total',
  'circuit_breaker_open',
  'pending_references_resolved_total',
] as const;

/**
 * Every metric of the service, in a registry of its own (never the prom-client global one), so two apps in the
 * same process (the e2e suites) never share a counter. Callers go through the decorators and hooks, not here.
 */
export class WageringMetrics {
  readonly registry = new Registry();

  readonly wagerTransactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager submissions decided (HTTP and SQS), replays excluded, by final or pending status and kind.',
    labelNames: ['status', 'kind'] as const,
    registers: [this.registry],
  });

  readonly idempotentDuplicates = new Counter({
    name: 'idempotent_duplicates_total',
    help: 'Submissions answered as an idempotent replay of an earlier decision, by channel.',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'retries_total',
    help: 'Work handed back to be tried again: sqs (message visibility), outbox (failed publish), pending_reference.',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  readonly deadLetters = new Counter({
    name: 'dlq_messages_total',
    help: 'Messages the consumer moved to the dead-letter queue, by reason.',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Units of work aborted by lock_timeout (55P03) or a deadlock (40P01).',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  readonly lockWait = new Histogram({
    name: 'lock_wait_seconds',
    help: 'Time spent acquiring the wallet row lock (SELECT ... FOR UPDATE), timeouts included.',
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  readonly outboxLag = new Histogram({
    name: 'outbox_lag_seconds',
    help: 'Time between the commit that wrote an outbox event and its publication.',
    buckets: LAG_BUCKETS,
    registers: [this.registry],
  });

  readonly outboxAttemptsExhausted = new Counter({
    name: 'outbox_attempts_exhausted_total',
    help: 'Outbox events that just used up their publish attempts and now need an operator.',
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'processing_duration_seconds',
    help: 'Duration of a use case or of one SQS message, by operation and outcome.',
    labelNames: ['operation', 'outcome'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliations that found the wallet balance out of line with its ledger.',
    registers: [this.registry],
  });

  readonly circuitBreakerOpen = new Gauge({
    name: 'circuit_breaker_open',
    help: '1 while the breaker holds work back (open or half-open), 0 when closed.',
    labelNames: ['breaker'] as const,
    registers: [this.registry],
  });

  readonly pendingReferencesResolved = new Counter({
    name: 'pending_references_resolved_total',
    help: 'PENDING_REFERENCE transactions the worker decided, by status (exhausted ones are REJECTED by timeout).',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
