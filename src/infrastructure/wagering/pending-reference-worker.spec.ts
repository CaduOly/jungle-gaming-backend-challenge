import { describe, expect, it } from 'bun:test';
import type { RetryPendingReferencesOutput } from '../../business/wagering/use-case/retry-pending-references/retry-pending-references';
import { PendingReferenceWorker, type RetryPendingRound } from './pending-reference-worker';

const output = (claimed: number): RetryPendingReferencesOutput => ({
  claimed,
  processed: claimed,
  rejected: 0,
  exhausted: 0,
  rescheduled: 0,
  failed: 0,
  skipped: 0,
  erroredIds: [],
  unattemptedIds: [],
});

const until = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(1);
  }
};

const scripted = (script: Array<() => Promise<RetryPendingReferencesOutput>>) => {
  let rounds = 0;
  const round: RetryPendingRound = {
    execute: () => {
      const step = script[Math.min(rounds, script.length - 1)];
      rounds += 1;
      return step ? step() : Promise.resolve(output(0));
    },
  };
  return { round, rounds: () => rounds };
};

describe('PendingReferenceWorker', () => {
  it('runs a round right away and hands every output to the callback', async () => {
    const rounds = scripted([async () => output(2), async () => output(0)]);
    const outputs: RetryPendingReferencesOutput[] = [];
    const worker = new PendingReferenceWorker(rounds.round, {
      batchSize: 2,
      pollIntervalMs: 60_000,
      onRound: (round) => outputs.push(round),
    });

    worker.start();
    await until(() => outputs.length === 2);
    await worker.stop();

    expect(outputs.map((round) => round.claimed)).toEqual([2, 0]);
  });

  it('drains back to back while rounds fill the batch and waits the poll interval after a partial one', async () => {
    const rounds = scripted([async () => output(3), async () => output(3), async () => output(1), async () => output(0)]);
    const worker = new PendingReferenceWorker(rounds.round, { batchSize: 3, pollIntervalMs: 60_000 });

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
    const worker = new PendingReferenceWorker(rounds.round, {
      batchSize: 10,
      pollIntervalMs: 5,
      onError: (error) => errors.push(error),
    });

    worker.start();
    await until(() => rounds.rounds() >= 3);
    await worker.stop();

    expect(errors).toEqual([boom]);
  });

  it('stops gracefully: waits for the round in flight, reports it and starts no other', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rounds = scripted([
      async () => {
        await blocked;
        return output(10);
      },
    ]);
    const outputs: RetryPendingReferencesOutput[] = [];
    const worker = new PendingReferenceWorker(rounds.round, {
      batchSize: 10,
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

  it('tells the round in flight to stop between items once stop() is called', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: boolean[] = [];
    const round: RetryPendingRound = {
      execute: async (input) => {
        seen.push(input?.shouldStop?.() ?? false);
        await blocked;
        seen.push(input?.shouldStop?.() ?? false);
        return output(1);
      },
    };
    const worker = new PendingReferenceWorker(round, { batchSize: 10, pollIntervalMs: 60_000 });

    worker.start();
    await until(() => seen.length === 1);
    const stopping = worker.stop();
    release();
    await stopping;

    expect(seen).toEqual([false, true]);
  });

  it('runOnce runs a single round without starting the loop', async () => {
    const rounds = scripted([async () => output(4)]);
    const worker = new PendingReferenceWorker(rounds.round, { batchSize: 4, pollIntervalMs: 1 });

    expect(await worker.runOnce()).toEqual(output(4));
    await Bun.sleep(20);

    expect(worker.isRunning).toBe(false);
    expect(rounds.rounds()).toBe(1);
  });
});
