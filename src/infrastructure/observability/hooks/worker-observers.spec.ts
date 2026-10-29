import { describe, expect, it } from 'bun:test';
import { LogCapture } from '../../../../tests/support/fakes/log-capture';
import { createLogger } from '../logging/logger';
import { metricValue } from '../metrics/metric-value';
import { WageringMetrics } from '../metrics/wagering-metrics';
import { WorkerObservers } from './worker-observers';

const setup = () => {
  const capture = new LogCapture();
  const metrics = new WageringMetrics();
  return { capture, metrics, observers: new WorkerObservers(metrics, createLogger({ destination: capture })) };
};

const message = { sqsMessageId: 'sqs-1', receiveCount: 2 };

describe('WorkerObservers', () => {
  it('times every consumed message and counts retries and dead letters by reason', async () => {
    const { metrics, observers, capture } = setup();

    observers.consumerOutcome({ message, outcome: { kind: 'ack' }, durationMs: 20 });
    observers.consumerOutcome({ message, outcome: { kind: 'retry', delayMs: 500 }, durationMs: 5 });
    observers.consumerOutcome({ message, outcome: { kind: 'dead-letter', reason: 'invalid_schema' }, durationMs: 1 });

    expect(await metricValue(metrics, 'processing_duration_seconds', { operation: 'sqs_message', outcome: 'ack' })).toBe(1);
    expect(await metricValue(metrics, 'retries_total', { source: 'sqs' })).toBe(1);
    expect(await metricValue(metrics, 'dlq_messages_total', { reason: 'invalid_schema' })).toBe(1);
    expect(capture.find('sqs message moved to the dead-letter queue')).toMatchObject({
      level: 'error',
      sqsMessageId: 'sqs-1',
      reason: 'invalid_schema',
    });
  });

  it('reports the breaker as open while it is open or half-open, starting at 0', async () => {
    const { metrics, observers } = setup();
    const report = observers.circuitState('sqs_consumer');
    expect(await metricValue(metrics, 'circuit_breaker_open', { breaker: 'sqs_consumer' })).toBe(0);

    report('open');
    expect(await metricValue(metrics, 'circuit_breaker_open', { breaker: 'sqs_consumer' })).toBe(1);
    report('half-open');
    expect(await metricValue(metrics, 'circuit_breaker_open', { breaker: 'sqs_consumer' })).toBe(1);
    report('closed');
    expect(await metricValue(metrics, 'circuit_breaker_open', { breaker: 'sqs_consumer' })).toBe(0);
  });

  it('counts failed publications as outbox retries and the exhausted events once', async () => {
    const { metrics, observers, capture } = setup();

    observers.outboxRound({ published: 3, failed: 2, exhausted: 1, exhaustedMessageIds: ['outbox-9'] });
    observers.outboxRound({ published: 1, failed: 0, exhausted: 0, exhaustedMessageIds: [] });

    expect(await metricValue(metrics, 'retries_total', { source: 'outbox' })).toBe(2);
    expect(await metricValue(metrics, 'outbox_attempts_exhausted_total')).toBe(1);
    expect(capture.find('outbox events used up their publish attempts')).toMatchObject({ outboxMessageIds: ['outbox-9'] });
  });

  it('counts the pending references the worker decided and the ones it will try again', async () => {
    const { metrics, observers } = setup();

    observers.pendingRound({ processed: 2, rejected: 1, exhausted: 1, rescheduled: 3, erroredIds: ['a'] });

    expect(await metricValue(metrics, 'pending_references_resolved_total', { status: 'PROCESSED' })).toBe(2);
    expect(await metricValue(metrics, 'pending_references_resolved_total', { status: 'REJECTED' })).toBe(1);
    expect(await metricValue(metrics, 'pending_references_resolved_total', { status: 'EXHAUSTED' })).toBe(1);
    expect(await metricValue(metrics, 'retries_total', { source: 'pending_reference' })).toBe(4);
  });

  it('logs a failed worker round with its error class', () => {
    const { observers, capture } = setup();

    observers.workerError('outbox_publisher')(new Error('connection refused'), 'poll');

    expect(capture.find('outbox_publisher round failed')).toMatchObject({
      level: 'warn',
      worker: 'outbox_publisher',
      operation: 'poll',
      errorClass: 'unexpected',
      errorMessage: 'connection refused',
    });
  });
});
