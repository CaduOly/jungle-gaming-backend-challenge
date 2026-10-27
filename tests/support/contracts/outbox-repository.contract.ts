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
      for (const message of claimed) expect(message.lockedUntil).toEqual(at(10 + LEASE_MS));
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

    it('ignores late updates from a publisher whose lease expired after another one published', async () => {
      await repository.add([aMessage()]);
      const [stale] = await repository.claimBatch(1, LEASE_MS, at(0));
      const [winner] = await repository.claimBatch(1, LEASE_MS, at(LEASE_MS));

      winner!.markPublished(at(LEASE_MS + 1));
      await repository.markPublished(winner!);

      stale!.scheduleRetry(at(LEASE_MS + 2), 0);
      await repository.scheduleRetry(stale!);
      const lateDuplicate = OutboxMessage.rehydrate(winner!.toState());
      await repository.markPublished(lateDuplicate);

      expect(await repository.claimBatch(10, LEASE_MS, at(LEASE_MS * 10))).toEqual([]);
    });

    it('persists a scheduled retry and releases the lease', async () => {
      const message = aMessage();
      await repository.add([message]);
      const [claimed] = await repository.claimBatch(1, LEASE_MS, at(0));

      claimed!.scheduleRetry(at(10), 2_000);
      await repository.scheduleRetry(claimed!);

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
