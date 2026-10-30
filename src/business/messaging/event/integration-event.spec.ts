import { describe, expect, it } from 'bun:test';
import { aFakeEvent, FakeIntegrationEvent } from '../../../../tests/support/fakes/fake-integration-event';
import { InvalidIntegrationEventError } from '../error/invalid-integration-event-error';
import { IntegrationEvent, type IntegrationEventProps } from './integration-event';

class LooseEvent<T> extends IntegrationEvent<T> {
  readonly eventType = 'Loose';
  readonly version = 1;
  readonly aggregateType = 'Test';

  constructor(props: IntegrationEventProps<T>) {
    super(props);
  }
}

const envelope = {
  eventId: 'evt-loose',
  aggregateId: 'aggregate-1',
  correlationId: 'correlation-1',
  occurredAt: new Date('2026-07-29T15:00:00.000Z'),
};

class Amount {
  constructor(private readonly cents: bigint) {}

  toJSON(): string {
    return `${this.cents / 100n}.${(this.cents % 100n).toString().padStart(2, '0')}`;
  }
}

describe('IntegrationEvent', () => {
  it('serializes to the versioned envelope with an ISO-8601 occurredAt', () => {
    const event = aFakeEvent({ eventId: 'evt-1' });

    expect(event.toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'FakeHappened',
      version: 2,
      aggregateType: 'Wallet',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'message-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: event.data,
    });
  });

  it('survives a JSON round trip unchanged', () => {
    const envelope = aFakeEvent().toJSON();
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('omits causationId from the envelope when there is none', () => {
    const envelope = aFakeEvent({ causationId: undefined }).toJSON();
    expect('causationId' in envelope).toBe(false);
  });

  it('is immune to later mutation of the inputs', () => {
    const occurredAt = new Date('2026-07-29T15:00:00.000Z');
    const data = { walletId: 'wallet-1', amount: '25.00', walletVersion: 1 };
    const event = aFakeEvent({ occurredAt, data });

    occurredAt.setUTCFullYear(2000);
    data.amount = '99.00';

    expect(event.occurredAt.toISOString()).toBe('2026-07-29T15:00:00.000Z');
    expect(event.data.amount).toBe('25.00');
    expect(Object.isFrozen(event.data)).toBe(true);
  });

  it.each([
    ['eventId', { eventId: '' }],
    ['aggregateId', { aggregateId: ' ' }],
    ['correlationId', { correlationId: '' }],
    ['causationId', { causationId: '' }],
    ['occurredAt', { occurredAt: new Date('invalid') }],
  ])('rejects an invalid %s', (_field, overrides) => {
    expect(() => aFakeEvent(overrides)).toThrow(InvalidIntegrationEventError);
  });

  it('keeps eventType and version on the type', () => {
    const event = aFakeEvent();
    expect(event).toBeInstanceOf(FakeIntegrationEvent);
    expect(event.eventType).toBe('FakeHappened');
    expect(event.version).toBe(2);
  });

  it('stores plain JSON: Dates become ISO strings at runtime and are rejected at compile time', () => {
    const event = new LooseEvent<{ at: Date }>({
      ...envelope,
      // @ts-expect-error Date não é JSON puro
      data: { at: new Date('2026-07-29T15:00:00.000Z') },
    });

    expect(event.data as unknown).toEqual({ at: '2026-07-29T15:00:00.000Z' });
    expect(event.toJSON().data as unknown).toEqual({ at: '2026-07-29T15:00:00.000Z' });
  });

  it('honours toJSON of nested objects and rejects them at compile time', () => {
    const event = new LooseEvent<{ money: Amount }>({
      ...envelope,
      // @ts-expect-error instância de classe não é JSON puro
      data: { money: new Amount(2_550n) },
    });

    expect(event.data as unknown).toEqual({ money: '25.50' });
  });

  it('drops undefined optional fields', () => {
    const event = new LooseEvent<{ id: string; note?: string }>({ ...envelope, data: { id: 'x', note: undefined } });
    expect('note' in event.data).toBe(false);
  });

  it('accepts interfaces made of JSON values, including nested arrays and nulls', () => {
    interface Nested {
      readonly items: readonly { readonly amount: string; readonly tags: string[] }[];
      readonly parent: string | null;
      readonly flag: boolean;
    }
    const data: Nested = { items: [{ amount: '1.00', tags: ['a'] }], parent: null, flag: true };
    expect(new LooseEvent<Nested>({ ...envelope, data }).toJSON().data).toEqual(data);
  });
});
