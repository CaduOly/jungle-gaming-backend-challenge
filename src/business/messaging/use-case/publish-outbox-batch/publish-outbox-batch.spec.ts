import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../../../tests/support/fakes/fake-clock';
import { aFakeEvent } from '../../../../../tests/support/fakes/fake-integration-event';
import { FakeMessagePublisher } from '../../../../../tests/support/fakes/fake-message-publisher';
import { InMemoryOutboxRepository } from '../../../../../tests/support/fakes/in-memory-outbox.repository';
import { ExponentialBackoff } from '../../../shared/policy/exponential-backoff';
import { OutboxMessage } from '../../entity/outbox-message';
import type { IMessagePublisher } from '../../port/message-publisher.port';
import { PublishOutboxBatch } from './publish-outbox-batch';

const LEASE_MS = 30_000;

describe('PublishOutboxBatch', () => {
  let clock: FakeClock;
  let outbox: InMemoryOutboxRepository;
  let publisher: FakeMessagePublisher;
  let backoff: ExponentialBackoff;

  const useCase = (batchSize = 10) =>
    new PublishOutboxBatch(outbox, publisher, clock, backoff, { batchSize, leaseMs: LEASE_MS });

  const enqueue = async (count: number, startMs = count * -1, aggregateOf = (index: number) => `wallet-${index}`) => {
    const messages = Array.from({ length: count }, (_, index) =>
      OutboxMessage.fromEvent(
        aFakeEvent({
          eventId: `evt-${index}`,
          aggregateId: aggregateOf(index),
          occurredAt: new Date(clock.now().getTime() + startMs + index),
        }),
      ),
    );
    await outbox.add(messages);
    return messages;
  };

  beforeEach(() => {
    clock = new FakeClock();
    outbox = new InMemoryOutboxRepository();
    publisher = new FakeMessagePublisher();
    backoff = new ExponentialBackoff({ baseMs: 2_000, capMs: 60_000, maxAttempts: 8, random: () => 0 });
  });

  it('reports zeros when nothing is due', async () => {
    expect(await useCase().execute()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
      leaseLost: 0,
      exhausted: 0,
      exhaustedMessageIds: [],
    });
  });

  it('publishes every due message oldest first and marks them as published', async () => {
    await enqueue(3);

    const output = await useCase().execute();

    expect(output).toMatchObject({ claimed: 3, published: 3, failed: 0, exhausted: 0 });
    expect(publisher.publishedIds()).toEqual(['evt-0', 'evt-1', 'evt-2']);
    expect(outbox.pending()).toEqual([]);
    expect((await outbox.findById('evt-0'))!.publishedAt).toEqual(clock.now());
  });

  it('claims at most batchSize messages per run', async () => {
    await enqueue(5);

    expect(await useCase(2).execute()).toMatchObject({ claimed: 2, published: 2 });
    expect(outbox.pending()).toHaveLength(3);
  });

  it('schedules a retry with backoff when publishing fails, without blocking the rest of the batch', async () => {
    await enqueue(3);
    publisher.failWhen((message) => message.id === 'evt-1');

    const output = await useCase().execute();

    expect(output).toMatchObject({ claimed: 3, published: 2, failed: 1, exhausted: 0 });
    const retried = (await outbox.findById('evt-1'))!;
    expect(retried.attempts).toBe(1);
    expect(retried.nextAttemptAt).toEqual(new Date(clock.now().getTime() + 1_000));
    expect(retried.lockedUntil).toBeUndefined();
  });

  it('never lets an aggregate overtake a failed head, even one message per round', async () => {
    await enqueue(3, -3, () => 'wallet-a');
    publisher.failNext();

    expect(await useCase(1).execute()).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    expect(await useCase(1).execute()).toMatchObject({ claimed: 0 });

    clock.set((await outbox.findById('evt-0'))!.nextAttemptAt);
    for (let round = 0; round < 3; round += 1) expect(await useCase(1).execute()).toMatchObject({ published: 1 });
    expect(publisher.publishedIds()).toEqual(['evt-0', 'evt-1', 'evt-2']);
  });

  it('publishes a failed message again once its backoff elapses', async () => {
    await enqueue(1);
    publisher.failNext();
    await useCase().execute();

    clock.advance(999);
    expect(await useCase().execute()).toMatchObject({ claimed: 0 });

    clock.advance(1);
    expect(await useCase().execute()).toMatchObject({ claimed: 1, published: 1 });
    expect(publisher.publishedIds()).toEqual(['evt-0']);
  });

  it('grows the delay exponentially across consecutive failures', async () => {
    await enqueue(1);
    publisher.failWhen(() => true);
    const delays: number[] = [];

    for (let run = 0; run < 4; run += 1) {
      const before = clock.now().getTime();
      await useCase().execute();
      const next = (await outbox.findById('evt-0'))!.nextAttemptAt.getTime();
      delays.push(next - before);
      clock.set(new Date(next));
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('reports exhausted messages but keeps retrying them at the capped delay', async () => {
    const [message] = await enqueue(1);
    const almostExhausted = OutboxMessage.rehydrate({ ...message!.toState(), id: 'evt-tired', aggregateId: 'wallet-tired', attempts: 7 });
    await outbox.add([almostExhausted]);
    publisher.failWhen(() => true);

    const output = await useCase().execute();

    expect(output).toMatchObject({ claimed: 2, published: 0, failed: 2, exhausted: 1, exhaustedMessageIds: ['evt-tired'] });
    const tired = (await outbox.findById('evt-tired'))!;
    expect(tired.attempts).toBe(8);
    expect(tired.isPending()).toBe(true);
    expect(tired.nextAttemptAt).toEqual(new Date(clock.now().getTime() + 30_000));
  });

  it('reports exhaustion only once, when the ceiling is crossed', async () => {
    const [message] = await enqueue(1);
    await outbox.add([OutboxMessage.rehydrate({ ...message!.toState(), id: 'evt-dead', aggregateId: 'wallet-dead', attempts: 8 })]);
    publisher.failWhen(() => true);

    expect(await useCase().execute()).toMatchObject({ failed: 2, exhausted: 0, exhaustedMessageIds: [] });
    expect((await outbox.findById('evt-dead'))!.attempts).toBe(9);
  });

  it('never publishes the same message twice across concurrent publishers', async () => {
    await enqueue(20);

    const outputs = await Promise.all([useCase(8).execute(), useCase(8).execute(), useCase(8).execute()]);

    expect(outputs.reduce((total, output) => total + output.published, 0)).toBe(20);
    expect(new Set(publisher.publishedIds()).size).toBe(20);
    expect(publisher.publishedIds()).toHaveLength(20);
  });

  it('republishes after the lease expires when the process dies between publish and mark', async () => {
    await enqueue(1);
    const crashingOutbox = Object.create(outbox) as InMemoryOutboxRepository;
    crashingOutbox.markPublished = async () => {
      throw new Error('process died');
    };
    const crashing = new PublishOutboxBatch(crashingOutbox, publisher, clock, backoff, {
      batchSize: 10,
      leaseMs: LEASE_MS,
    });

    await expect(crashing.execute()).rejects.toThrow('process died');
    expect(await useCase().execute()).toMatchObject({ claimed: 0 });

    clock.advance(LEASE_MS);
    expect(await useCase().execute()).toMatchObject({ claimed: 1, published: 1 });
    expect(publisher.publishedIds()).toEqual(['evt-0', 'evt-0']);
  });

  it('fences a stale publisher: its late failure neither touches the row nor counts exhaustion twice', async () => {
    await enqueue(1);
    backoff = new ExponentialBackoff({ baseMs: 2_000, capMs: 60_000, maxAttempts: 1, random: () => 0 });
    let releaseStale: (error: Error) => void = () => undefined;
    let calls = 0;
    const scripted: IMessagePublisher = {
      publish: () => {
        calls += 1;
        if (calls === 1) return new Promise<void>((_, reject) => (releaseStale = reject));
        return Promise.reject(new Error('broker down'));
      },
    };
    const publisherFor = () =>
      new PublishOutboxBatch(outbox, scripted, clock, backoff, { batchSize: 10, leaseMs: LEASE_MS });

    const stale = publisherFor().execute();
    await Promise.resolve();
    clock.advance(LEASE_MS);
    const owner = await publisherFor().execute();
    const afterOwner = (await outbox.findById('evt-0'))!.toState();

    clock.advance(1);
    releaseStale(new Error('timed out'));
    const late = await stale;

    expect(owner).toMatchObject({ failed: 1, leaseLost: 0, exhausted: 1, exhaustedMessageIds: ['evt-0'] });
    expect(late).toMatchObject({ failed: 1, leaseLost: 1, exhausted: 0, exhaustedMessageIds: [] });
    expect((await outbox.findById('evt-0'))!.toState()).toEqual(afterOwner);
    expect(afterOwner.attempts).toBe(1);
  });
});
