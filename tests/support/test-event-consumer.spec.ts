import { describe, expect, it } from 'bun:test';
import type { IntegrationEventEnvelope } from '../../src/business/messaging/event/integration-event';
import { EventCollector, parseEnvelope } from './test-event-consumer';

const envelope = (eventId: string, aggregateId: string, data: unknown = {}): IntegrationEventEnvelope => ({
  eventId,
  eventType: 'FakeHappened',
  version: 1,
  aggregateType: 'Wallet',
  aggregateId,
  correlationId: 'corr',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data,
});

describe('EventCollector', () => {
  it('deduplicates by eventId but keeps every delivery for inspection', () => {
    const collector = new EventCollector();
    collector.record({ envelope: envelope('e1', 'w1') });
    collector.record({ envelope: envelope('e1', 'w1') });
    collector.record({ envelope: envelope('e2', 'w1') });

    expect(collector.events().map((event) => event.eventId)).toEqual(['e1', 'e2']);
    expect(collector.deliveries).toHaveLength(3);
    expect(collector.deliveriesOf('e1')).toHaveLength(2);
    expect(collector.has('e2')).toBe(true);
    expect([...collector.eventIds()]).toEqual(['e1', 'e2']);
  });

  it('orders an aggregate by walletVersion, not by arrival', () => {
    const collector = new EventCollector();
    collector.record({ envelope: envelope('e3', 'w1', { walletVersion: 3 }) });
    collector.record({ envelope: envelope('x1', 'w2', { walletVersion: 1 }) });
    collector.record({ envelope: envelope('e1', 'w1', { walletVersion: 1 }) });
    collector.record({ envelope: envelope('e2', 'w1', { walletVersion: 2 }) });

    expect(collector.byAggregate('w1').map((event) => event.eventId)).toEqual(['e1', 'e2', 'e3']);
    expect(collector.byAggregate('w2').map((event) => event.eventId)).toEqual(['x1']);
    expect(collector.aggregateIds()).toEqual(['w1', 'w2']);
  });

  it('keeps arrival order when some event has no walletVersion', () => {
    const collector = new EventCollector();
    collector.record({ envelope: envelope('e2', 'w1', { walletVersion: 2 }) });
    collector.record({ envelope: envelope('e1', 'w1', {}) });

    expect(collector.byAggregate('w1').map((event) => event.eventId)).toEqual(['e2', 'e1']);
  });
});

describe('parseEnvelope', () => {
  it('parses a JSON envelope', () => {
    expect(parseEnvelope(JSON.stringify(envelope('e1', 'w1'))).eventId).toBe('e1');
  });

  it.each(['not json', '[]', '{"eventId":1}', undefined])('rejects %p', (body) => {
    expect(() => parseEnvelope(body)).toThrow();
  });
});
