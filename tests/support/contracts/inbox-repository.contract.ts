import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../src/business/messaging/entity/inbox-message';
import type { IInboxRepository } from '../../../src/business/messaging/port/inbox.repository.port';
import { uuidv7 } from '../uuid';

export interface InboxRepositoryHarness {
  readonly repository: IInboxRepository;
  readonly teardown?: () => Promise<void>;
}

const receivedAt = new Date('2026-07-29T15:00:00.000Z');
const processedAt = new Date('2026-07-29T15:00:01.000Z');

const aMessage = (messageId: string, payloadHash = 'hash-a', consumerName = 'wager-transactions') =>
  InboxMessage.create({ consumerName, messageId, payloadHash, receivedAt });

export const describeInboxRepositoryContract = (
  name: string,
  setup: () => Promise<InboxRepositoryHarness>,
): void => {
  describe(`IInboxRepository contract: ${name}`, () => {
    let harness: InboxRepositoryHarness;
    let repository: IInboxRepository;

    beforeEach(async () => {
      harness = await setup();
      repository = harness.repository;
    });

    afterEach(async () => {
      await harness.teardown?.();
    });

    it('inserts a message seen for the first time', async () => {
      expect(await repository.insertIfAbsent(aMessage(uuidv7()))).toEqual({ inserted: true });
    });

    it('returns the stored row when the message already exists, keeping the original hash', async () => {
      const messageId = uuidv7();
      await repository.insertIfAbsent(aMessage(messageId, 'hash-a'));

      const result = await repository.insertIfAbsent(aMessage(messageId, 'hash-b'));

      expect(result.inserted).toBe(false);
      if (result.inserted) return;
      expect(result.existing.payloadHash).toBe('hash-a');
      expect(result.existing.isProcessed()).toBe(false);
      expect(result.existing.matchesPayload('hash-b')).toBe(false);
    });

    it('reports a processed message as processed on redelivery', async () => {
      const message = aMessage(uuidv7());
      await repository.insertIfAbsent(message);
      message.markProcessed(processedAt);
      await repository.markProcessed(message);

      const result = await repository.insertIfAbsent(aMessage(message.messageId));

      expect(result.inserted).toBe(false);
      if (result.inserted) return;
      expect(result.existing.isProcessed()).toBe(true);
      expect(result.existing.processedAt).toEqual(processedAt);
    });

    it('scopes deduplication by consumer', async () => {
      const messageId = uuidv7();
      await repository.insertIfAbsent(aMessage(messageId, 'hash-a', 'consumer-a'));
      expect(await repository.insertIfAbsent(aMessage(messageId, 'hash-a', 'consumer-b'))).toEqual({ inserted: true });
    });

    it('lets exactly one of several concurrent inserts win', async () => {
      const messageId = uuidv7();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => repository.insertIfAbsent(aMessage(messageId))),
      );
      expect(results.filter((result) => result.inserted)).toHaveLength(1);
    });
  });
};
