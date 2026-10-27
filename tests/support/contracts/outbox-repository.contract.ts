import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../../src/business/messaging/entity/outbox-message';
import type { IOutboxRepository } from '../../../src/business/messaging/port/outbox.repository.port';
import { aFakeEvent } from '../fakes/fake-integration-event';
import { uuidv7 } from '../uuid';

export interface OutboxRepositoryHarness {
  readonly repository: IOutboxRepository;
  readonly teardown?: () => Promise<void>;
}

const t0 = new Date('2026-07-29T15:00:00.000Z');
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const LEASE_MS = 30_000;

const aMessage = (occurredAtMs = 0): OutboxMessage =>
  OutboxMessage.fromEvent(aFakeEvent({ eventId: uuidv7(), aggregateId: uuidv7(), occurredAt: at(occurredAtMs) }));

const ids = (messages: readonly OutboxMessage[]): string[] => messages.map((message) => message.id);

export const describeOutboxRepositoryContract = (
  name: string,
  setup: () => Promise<OutboxRepositoryHarness>,
): void => {
  describe(`IOutboxRepository contract: ${name}`, () => {
    let harness: OutboxRepositoryHarness;
    let repository: IOutboxRepository;

    beforeEach(async () => {
      harness = await setup();
      repository = harness.repository;
    });

    afterEach(async () => {
      await harness.teardown?.();
    });

    it('claims due messages oldest first, up to the limit, and leases them', async () => {
      const [first, second, third] = [aMessage(0), aMessage(1), aMessage(2)];
      await repository.add([third!, first!, second!]);

      const claimed = await repository.claimBatch(2, LEASE_MS, at(10));

      expect(ids(claimed)).toEqual([first!.id, second!.id]);
      for (const message of claimed) {
        expect(message.lockedUntil).toEqual(at(10 + LEASE_MS));
        expect(message.leaseToken).toBeDefined();
      }
    });

    it('does not claim a message before its nextAttemptAt', async () => {
      await repository.add([aMessage(1_000)]);
      expect(await repository.claimBatch(10, LEASE_MS, at(999))).toEqual([]);
      expect(await repository.claimBatch(10, LEASE_MS, at(1_000))).toHaveLength(1);
    });

    it('does not claim a leased message again until the lease expires', async () => {
      const message = aMessage();
      await repository.add([message]);

      expect(ids(await repository.claimBatch(10, LEASE_MS, at(0)))).toEqual([message.id]);
      expect(await repository.claimBatch(10, LEASE_MS, at(LEASE_MS - 1))).toEqual([]);
      expect(ids(await repository.claimBatch(10, LEASE_MS, at(LEASE_MS)))).toEqual([message.id]);
    });

    it('never hands the same message to concurrent claimers', async () => {
      const messages = Array.from({ length: 20 }, (_, index) => aMessage(index));
      await repository.add(messages);

      const batches = await Promise.all(
        Array.from({ length: 4 }, () => repository.claimBatch(20, LEASE_MS, at(100))),
      );

      const claimed = batches.flatMap(ids);
      expect(new Set(claimed).size).toBe(claimed.length);
      expect(claimed.sort()).toEqual(ids(messages).sort());
    });

    it('stops claiming a message once it is published', async () => {
      const message = aMessage();
      await repository.add([message]);
      const [claimed] = await repository.claimBatch(1, LEASE_MS, at(0));

      claimed!.markPublished(at(5));
      await repository.markPublished(claimed!);

      expect(await repository.claimBatch(10, LEASE_MS, at(LEASE_MS * 10))).toEqual([]);
    });

    it('fences off the retry of a publisher whose lease was reclaimed by another one', async () => {
      const message = aMessage();
      await repository.add([message]);
      const [stale] = await repository.claimBatch(1, LEASE_MS, at(0));
      const [owner] = await repository.claimBatch(1, LEASE_MS, at(LEASE_MS));
      expect(owner!.leaseToken).toBeDefined();
      expect(owner!.leaseToken).not.toBe(stale!.leaseToken);

      stale!.scheduleRetry(at(LEASE_MS + 1), 0);
      expect(await repository.scheduleRetry(stale!)).toBe(false);

      const stored = (await repository.findById(message.id))!;
      expect(stored.attempts).toBe(0);
      expect(stored.nextAttemptAt).toEqual(message.nextAttemptAt);
      expect(stored.lockedUntil).toEqual(at(LEASE_MS * 2));
      expect(await repository.claimBatch(10, LEASE_MS, at(LEASE_MS + 2))).toEqual([]);
    });

    it('never lets a stale retry regress attempts written by the current owner', async () => {
      const message = aMessage();
      await repository.add([message]);
      const [stale] = await repository.claimBatch(1, LEASE_MS, at(0));
      const [first] = await repository.claimBatch(1, LEASE_MS, at(LEASE_MS));
      first!.scheduleRetry(at(LEASE_MS), 0);
      expect(await repository.scheduleRetry(first!)).toBe(true);
      const [second] = await repository.claimBatch(1, LEASE_MS, at(LEASE_MS));
      second!.scheduleRetry(at(LEASE_MS), 5_000);
      expect(await repository.scheduleRetry(second!)).toBe(true);

      stale!.scheduleRetry(at(LEASE_MS + 1), 0);
      expect(await repository.scheduleRetry(stale!)).toBe(false);

      const stored = (await repository.findById(message.id))!;
      expect(stored.attempts).toBe(2);
      expect(stored.nextAttemptAt).toEqual(at(LEASE_MS + 5_000));
      expect(stored.lockedUntil).toBeUndefined();
    });

    it('keeps a published message intact against stale retries and duplicate publications', async () => {
      const message = aMessage();
      await repository.add([message]);
      const [stale] = await repository.claimBatch(1, LEASE_MS, at(0));
      const [winner] = await repository.claimBatch(1, LEASE_MS, at(LEASE_MS));

      winner!.markPublished(at(LEASE_MS + 1));
      await repository.markPublished(winner!);

      const retry = OutboxMessage.rehydrate(stale!.toState());
      retry.scheduleRetry(at(LEASE_MS + 2), 0);
      expect(await repository.scheduleRetry(retry)).toBe(false);
      stale!.markPublished(at(LEASE_MS + 3));
      await repository.markPublished(stale!);

      const stored = (await repository.findById(message.id))!;
      expect(stored.publishedAt).toEqual(at(LEASE_MS + 1));
      expect(stored.attempts).toBe(0);
      expect(stored.nextAttemptAt).toEqual(message.nextAttemptAt);
      expect(stored.lockedUntil).toBeUndefined();
      expect(await repository.claimBatch(10, LEASE_MS, at(LEASE_MS * 10))).toEqual([]);
    });

    it('refuses a retry for a message that was never claimed', async () => {
      const message = aMessage();
      await repository.add([message]);
      message.scheduleRetry(at(1), 0);
      expect(await repository.scheduleRetry(message)).toBe(false);
      expect((await repository.findById(message.id))!.attempts).toBe(0);
    });

    it('finds a message by id and returns undefined for an unknown one', async () => {
      const message = aMessage();
      await repository.add([message]);
      expect((await repository.findById(message.id))!.payload).toEqual(message.payload);
      expect(await repository.findById(uuidv7())).toBeUndefined();
    });

    it('persists a scheduled retry and releases the lease', async () => {
      const message = aMessage();
      await repository.add([message]);
      const [claimed] = await repository.claimBatch(1, LEASE_MS, at(0));

      claimed!.scheduleRetry(at(10), 2_000);
      expect(await repository.scheduleRetry(claimed!)).toBe(true);

      expect(await repository.claimBatch(10, LEASE_MS, at(2_009))).toEqual([]);
      const [again] = await repository.claimBatch(10, LEASE_MS, at(2_010));
      expect(again!.id).toBe(message.id);
      expect(again!.attempts).toBe(1);
      expect(again!.nextAttemptAt).toEqual(at(2_010));
    });

    it('preserves the envelope payload', async () => {
      const message = aMessage();
      await repository.add([message]);
      const [claimed] = await repository.claimBatch(1, LEASE_MS, at(0));
      expect(claimed!.payload).toEqual(message.payload);
      expect(claimed!.eventType).toBe(message.eventType);
      expect(claimed!.aggregateType).toBe(message.aggregateType);
      expect(claimed!.aggregateId).toBe(message.aggregateId);
    });

    it('rejects a duplicate id', async () => {
      const message = aMessage();
      await repository.add([message]);
      await expect(repository.add([message])).rejects.toThrow();
    });
  });
};
