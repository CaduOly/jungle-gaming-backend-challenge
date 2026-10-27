import { describe, expect, it } from 'bun:test';
import { InboxMessageAlreadyProcessedError } from '../error/inbox-message-already-processed.error';
import { InboxPayloadMismatchError } from '../error/inbox-payload-mismatch.error';
import { InvalidInboxMessageError } from '../error/invalid-inbox-message.error';
import { InboxMessage } from './inbox-message';

const receivedAt = new Date('2026-07-29T15:00:00.000Z');
const processedAt = new Date('2026-07-29T15:00:01.000Z');

const aMessage = () =>
  InboxMessage.create({ consumerName: 'wager-transactions', messageId: 'msg-123', payloadHash: 'hash-a', receivedAt });

describe('InboxMessage', () => {
  it('is created unprocessed', () => {
    const message = aMessage();

    expect(message.consumerName).toBe('wager-transactions');
    expect(message.messageId).toBe('msg-123');
    expect(message.payloadHash).toBe('hash-a');
    expect(message.receivedAt).toEqual(receivedAt);
    expect(message.processedAt).toBeUndefined();
    expect(message.isProcessed()).toBe(false);
  });

  it('marks itself as processed', () => {
    const message = aMessage();
    message.markProcessed(processedAt);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(processedAt);
  });

  it('refuses to be processed twice', () => {
    const message = aMessage();
    message.markProcessed(processedAt);

    expect(() => message.markProcessed(processedAt)).toThrow(InboxMessageAlreadyProcessedError);
  });

  it('compares a received hash with the stored one', () => {
    expect(aMessage().matchesPayload('hash-a')).toBe(true);
    expect(aMessage().matchesPayload('hash-b')).toBe(false);
  });

  it('flags the same messageId with a different payload as a permanent violation', () => {
    expect(() => aMessage().ensureSamePayload('hash-a')).not.toThrow();

    expect(() => aMessage().ensureSamePayload('hash-b')).toThrow(
      expect.objectContaining({ messageId: 'msg-123', consumerName: 'wager-transactions' }),
    );
    expect(() => aMessage().ensureSamePayload('hash-b')).toThrow(InboxPayloadMismatchError);
  });

  it('round-trips through its persisted state', () => {
    const message = aMessage();
    message.markProcessed(processedAt);

    const rehydrated = InboxMessage.rehydrate(message.toState());

    expect(rehydrated.toState()).toEqual(message.toState());
    expect(rehydrated.isProcessed()).toBe(true);
  });

  it('does not leak its dates to the caller', () => {
    const message = aMessage();
    message.receivedAt.setUTCFullYear(2000);
    expect(message.receivedAt).toEqual(receivedAt);
  });

  it.each([
    ['consumerName', { consumerName: '' }],
    ['messageId', { messageId: ' ' }],
    ['payloadHash', { payloadHash: '' }],
    ['receivedAt', { receivedAt: new Date('invalid') }],
  ])('rejects an invalid %s', (_field, overrides) => {
    expect(() =>
      InboxMessage.create({
        consumerName: 'wager-transactions',
        messageId: 'msg-123',
        payloadHash: 'hash-a',
        receivedAt,
        ...overrides,
      }),
    ).toThrow(InvalidInboxMessageError);
  });
});
