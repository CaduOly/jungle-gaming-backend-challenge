import { describe, expect, it } from 'bun:test';
import { aFakeEvent } from '../../../../tests/support/fakes/fake-integration-event';
import { InvalidOutboxRetryError } from '../error/invalid-outbox-retry-error';
import { OutboxMessageAlreadyPublishedError } from '../error/outbox-message-already-published-error';
import { OutboxMessage } from './outbox-message';

const occurredAt = new Date('2026-07-29T15:00:00.000Z');
const later = (ms: number) => new Date(occurredAt.getTime() + ms);

const aMessage = () => OutboxMessage.fromEvent(aFakeEvent({ eventId: 'evt-1', aggregateId: 'wallet-9', occurredAt }));

describe('OutboxMessage', () => {
  it('is enqueued from an integration event carrying its envelope', () => {
    const event = aFakeEvent({ eventId: 'evt-1', aggregateId: 'wallet-9', occurredAt });
    const message = OutboxMessage.fromEvent(event);

    expect(message.id).toBe('evt-1');
    expect(message.eventType).toBe('FakeHappened');
    expect(message.aggregateType).toBe('Wallet');
    expect(message.aggregateId).toBe('wallet-9');
    expect(message.occurredAt).toEqual(occurredAt);
    expect(message.payload).toEqual(event.toJSON());
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(occurredAt);
    expect(message.lockedUntil).toBeUndefined();
    expect(message.publishedAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
  });

  it('has an immutable payload', () => {
    expect(Object.isFrozen(aMessage().payload)).toBe(true);
    expect(Object.isFrozen(aMessage().payload.data)).toBe(true);
  });

  it('is due once nextAttemptAt is reached and it is not leased', () => {
    const message = aMessage();
    expect(message.isDue(later(-1))).toBe(false);
    expect(message.isDue(occurredAt)).toBe(true);
  });

  it('is not due while another publisher holds the lease', () => {
    const message = OutboxMessage.rehydrate({ ...aMessage().toState(), lockedUntil: later(30_000) });
    expect(message.isDue(later(29_999))).toBe(false);
    expect(message.isDue(later(30_000))).toBe(true);
  });

  it('marks itself as published and releases the lease', () => {
    const message = OutboxMessage.rehydrate({ ...aMessage().toState(), lockedUntil: later(30_000) });
    message.markPublished(later(10));

    expect(message.publishedAt).toEqual(later(10));
    expect(message.lockedUntil).toBeUndefined();
    expect(message.isPending()).toBe(false);
    expect(message.isDue(later(60_000))).toBe(false);
  });

  it('refuses to be published twice', () => {
    const message = aMessage();
    message.markPublished(later(10));
    expect(() => message.markPublished(later(20))).toThrow(OutboxMessageAlreadyPublishedError);
  });

  it('schedules a retry: one more attempt, next attempt after the delay, lease released', () => {
    const message = OutboxMessage.rehydrate({ ...aMessage().toState(), lockedUntil: later(30_000) });
    message.scheduleRetry(later(100), 2_000);

    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(later(2_100));
    expect(message.lockedUntil).toBeUndefined();
    expect(message.isPending()).toBe(true);

    message.scheduleRetry(later(2_100), 4_000);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(later(6_100));
  });

  it('refuses a retry after being published', () => {
    const message = aMessage();
    message.markPublished(later(10));
    expect(() => message.scheduleRetry(later(20), 1_000)).toThrow(OutboxMessageAlreadyPublishedError);
  });

  it('keeps the lease token of its claim across transitions so the repository can fence writes', () => {
    const message = OutboxMessage.rehydrate({ ...aMessage().toState(), lockedUntil: later(30_000), leaseToken: 'lease-a' });
    message.scheduleRetry(later(1), 1_000);

    expect(message.leaseToken).toBe('lease-a');
    expect(message.lockedUntil).toBeUndefined();
  });

  it('rejects a retry whose next attempt would be an invalid date', () => {
    expect(() => aMessage().scheduleRetry(later(1), 8_640_000_000_000_000)).toThrow(InvalidOutboxRetryError);
  });

  it.each([-1, 1.5, Number.NaN])('rejects a retry delay of %p', (delay) => {
    expect(() => aMessage().scheduleRetry(later(1), delay)).toThrow(InvalidOutboxRetryError);
  });

  it('round-trips through its persisted state', () => {
    const message = aMessage();
    message.scheduleRetry(later(1), 1_000);
    const rehydrated = OutboxMessage.rehydrate(message.toState());

    expect(rehydrated.toState()).toEqual(message.toState());
  });

  it('rehydrates a published message without revalidating transitions', () => {
    const message = OutboxMessage.rehydrate({ ...aMessage().toState(), attempts: 3, publishedAt: later(5) });
    expect(message.isPending()).toBe(false);
    expect(message.attempts).toBe(3);
  });

  it('does not leak its dates to the caller', () => {
    const message = aMessage();
    message.nextAttemptAt.setUTCFullYear(2000);
    message.occurredAt.setUTCFullYear(2000);
    expect(message.nextAttemptAt).toEqual(occurredAt);
    expect(message.occurredAt).toEqual(occurredAt);
  });
});
