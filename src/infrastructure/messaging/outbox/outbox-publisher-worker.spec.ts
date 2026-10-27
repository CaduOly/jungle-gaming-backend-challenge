import { describe, expect, it } from 'bun:test';
import type { PublishOutboxBatchOutput } from '../../../business/messaging/use-case/publish-outbox-batch/publish-outbox-batch';
import { OutboxPublisherWorker } from './outbox-publisher-worker';

const output = (published: number): PublishOutboxBatchOutput => ({
  claimed: published,
  published,
  failed: 0,
  leaseLost: 0,
  exhausted: 0,
  exhaustedMessageIds: [],
});

const until = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(1);
  }
};

const scripted = (script: Array<() => Promise<PublishOutboxBatchOutput>>) => {
  let rounds = 0;
  const createRound = () => ({
    execute: () => {
      const step = script[Math.min(rounds, script.length - 1)];
      rounds += 1;
      return step ? step() : Promise.resolve(output(0));
    },
  });
  return { createRound, rounds: () => rounds };
};

describe('OutboxPublisherWorker', () => {
  it('runs a round right away and reports every output', async () => {
    const rounds = scripted([async () => output(2), async () => output(0)]);
    const outputs: PublishOutboxBatchOutput[] = [];
    const worker = new OutboxPublisherWorker(rounds.createRound, {
      pollIntervalMs: 60_000,
      onRound: (round) => outputs.push(round),
    });

    worker.start();
    await until(() => outputs.length === 2);
    await worker.stop();

    expect(outputs.map((round) => round.published)).toEqual([2, 0]);
  });

  it('drains back to back while rounds publish and waits the poll interval once idle', async () => {
    const rounds = scripted([async () => output(1), async () => output(1), async () => output(0)]);
    const worker = new OutboxPublisherWorker(rounds.createRound, { pollIntervalMs: 60_000 });

    worker.start();
    await until(() => rounds.rounds() === 3);
    await Bun.sleep(30);
    await worker.stop();

    expect(rounds.rounds()).toBe(3);
  });

  it('keeps polling after a failing round and reports the error', async () => {
    const boom = new Error('database is down');
    const rounds = scripted([() => Promise.reject(boom), async () => output(0)]);
    const errors: unknown[] = [];
    const worker = new OutboxPublisherWorker(rounds.createRound, {
      pollIntervalMs: 5,
      onError: (error) => errors.push(error),
    });

    worker.start();
    await until(() => rounds.rounds() >= 3);
    await worker.stop();

    expect(errors).toEqual([boom]);
  });

  it('survives an observer that throws', async () => {
    const rounds = scripted([async () => output(0)]);
    const worker = new OutboxPublisherWorker(rounds.createRound, {
      pollIntervalMs: 1,
      onRound: () => {
        throw new Error('metrics exploded');
      },
    });

    worker.start();
    await until(() => rounds.rounds() >= 3);
    await worker.stop();
  });

  it('stops gracefully: waits for the round in flight and starts no other', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rounds = scripted([
      async () => {
        await blocked;
        return output(1);
      },
    ]);
    const outputs: PublishOutboxBatchOutput[] = [];
    const worker = new OutboxPublisherWorker(rounds.createRound, {
      pollIntervalMs: 1,
      onRound: (round) => outputs.push(round),
    });

    worker.start();
    await until(() => rounds.rounds() === 1);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    expect(worker.isRunning).toBe(false);

    release();
    await stopping;
    await Bun.sleep(20);

    expect(outputs).toHaveLength(1);
    expect(rounds.rounds()).toBe(1);
  });

  it('stops immediately when idle and ignores a second start', async () => {
    const rounds = scripted([async () => output(0)]);
    const worker = new OutboxPublisherWorker(rounds.createRound, { pollIntervalMs: 60_000 });

    worker.start();
    worker.start();
    await until(() => rounds.rounds() === 1);
    await worker.stop();
    await Bun.sleep(20);

    expect(rounds.rounds()).toBe(1);
  });
});
