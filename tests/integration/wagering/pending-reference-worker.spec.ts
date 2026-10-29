import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import type { RetryPendingReferencesOutput } from '../../../src/business/wagering/use-case/retry-pending-references/retry-pending-references';
import {
  DEFAULT_PENDING_REFERENCE_WORKER_CONFIG,
  type PendingReferenceWorkerConfig,
} from '../../../src/infrastructure/config/pending-reference-worker-config';
import { UuidV7IdGenerator } from '../../../src/infrastructure/id/uuid-v7-id-generator';
import type { PendingReferenceWorker } from '../../../src/infrastructure/wagering/pending-reference-worker';
import { createPendingReferenceWorker } from '../../../src/infrastructure/wagering/pending-reference-worker.factory';
import { FakeClock } from '../../support/fakes/fake-clock';
import { aSubmission, type SubmissionOptions, type WalletView } from '../../support/fakes/fake-wagering-app';
import { uuidv7 } from '../../support/uuid';
import { countRows, createRealWageringApp, createWageringDatabase, type RealWageringApp, type WageringDatabase } from '../persistence/wagering-orm';

const until = async (condition: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
};

describe('PendingReferenceWorker over the real PostgreSQL unit of work', () => {
  let db: WageringDatabase;
  let app: RealWageringApp;
  let clock: FakeClock;
  const wallets = new Set<string>();
  const running: PendingReferenceWorker[] = [];

  beforeAll(async () => {
    db = await createWageringDatabase();
    clock = new FakeClock();
    app = createRealWageringApp(db.orm, { clock });
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((worker) => worker.stop()));
    await db.assertConsistent(wallets);
  });

  afterAll(() => db?.close());

  const workerWith = (
    config: Partial<PendingReferenceWorkerConfig> = {},
    observe: { outputs?: RetryPendingReferencesOutput[]; errors?: unknown[] } = {},
    orm: MikroORM = db.orm,
  ): PendingReferenceWorker => {
    const worker = createPendingReferenceWorker({
      em: orm.em,
      clock,
      ids: new UuidV7IdGenerator(),
      config: { ...DEFAULT_PENDING_REFERENCE_WORKER_CONFIG, pollIntervalMs: 5, ...config },
      lockTimeoutMs: 2_000,
      random: () => 0,
      onRound: (output) => observe.outputs?.push(output),
      onError: (error) => observe.errors?.push(error),
    });
    running.push(worker);
    return worker;
  };

  const open = async (balance = '100.00'): Promise<WalletView> => {
    const wallet = await app.createWallet.execute({ playerId: uuidv7(), initialBalance: { amount: balance, currency: 'BRL' } });
    wallets.add(wallet.id);
    return wallet;
  };
  const submit = (wallet: WalletView, kind: string, ext: string, options: SubmissionOptions = {}) =>
    app.process.execute(aSubmission(wallet, kind, ext, options));
  const balanceOf = async (wallet: WalletView): Promise<string> => (await app.getWallet.execute({ walletId: wallet.id })).balance.amount;
  const transactionRow = async (id: string) =>
    (await db.sql.query('SELECT status, failure_code, attempts FROM wager_transactions WHERE id = $1', [id])).rows[0];
  const eventsOf = (transactionId: string, eventType: string): Promise<number> =>
    countRows(db.sql, 'outbox_messages', 'event_type = $1 AND payload::text LIKE $2', [eventType, `%${transactionId}%`]);

  it('a ROLLBACK before its BET stays pending until the BET arrives, then the running worker settles it', async () => {
    const outputs: RetryPendingReferencesOutput[] = [];
    const wallet = await open();
    const bet = uuidv7();
    const rollback = await submit(wallet, 'ROLLBACK', uuidv7(), { amount: '30.00', reference: bet });
    expect(rollback).toMatchObject({ status: 'PENDING_REFERENCE' });

    workerWith({}, { outputs }).start();
    await until(() => outputs.length >= 3);
    expect(outputs.every((output) => output.claimed === 0)).toBe(true);

    expect((await submit(wallet, 'BET', bet, { amount: '30.00' })).balance?.amount).toBe('70.00');
    clock.advance(2_000);
    await until(() => outputs.some((output) => output.processed === 1));

    expect(await transactionRow(rollback.transactionId)).toMatchObject({ status: 'PROCESSED', failure_code: null });
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await eventsOf(rollback.transactionId, 'WagerTransactionProcessed')).toBe(1);
    expect(outputs.reduce((total, output) => total + output.processed, 0)).toBe(1);
  });

  it('runs out of attempts: REJECTED/REFERENCE_NOT_FOUND, the rejection lands in the outbox and the balance is untouched', async () => {
    const wallet = await open();
    const rollback = await submit(wallet, 'ROLLBACK', uuidv7(), { amount: '30.00', reference: uuidv7() });
    const worker = workerWith({ backoff: { baseMs: 2_000, capMs: 60_000, maxAttempts: 3 } });

    clock.advance(60_000);
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, rescheduled: 1, erroredIds: [] });
    expect(await transactionRow(rollback.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 2 });
    expect(await eventsOf(rollback.transactionId, 'WagerTransactionRejected')).toBe(0);

    clock.advance(60_000);
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, exhausted: 1, erroredIds: [] });

    expect(await transactionRow(rollback.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      attempts: 2,
    });
    expect(await eventsOf(rollback.transactionId, 'WagerTransactionRejected')).toBe(1);
    expect(await balanceOf(wallet)).toBe('100.00');
    clock.advance(60_000);
    expect(await worker.runOnce()).toMatchObject({ claimed: 0 });
  });

  describe('a BET arriving while the retry runs (both wait on the wallet lock)', () => {
    const lockWaiters = async (): Promise<number> =>
      countRows(db.sql, 'pg_stat_activity', "datname = current_database() AND wait_event_type = 'Lock'");

    const holdingWallet = async (walletId: string) => {
      const holder = new Client({ connectionString: db.database.url });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
      return {
        release: async () => {
          await holder.query('COMMIT');
          await holder.end();
        },
      };
    };

    it('worker first: it reschedules without seeing the uncommitted BET, the next round settles', async () => {
      const wallet = await open();
      const bet = uuidv7();
      const rollback = await submit(wallet, 'ROLLBACK', uuidv7(), { amount: '30.00', reference: bet });
      const worker = workerWith();
      clock.advance(2_000);

      const holder = await holdingWallet(wallet.id);
      const round = worker.runOnce();
      await until(async () => (await lockWaiters()) === 1);
      const betting = submit(wallet, 'BET', bet, { amount: '30.00' });
      await until(async () => (await lockWaiters()) === 2);
      await holder.release();

      expect(await round).toMatchObject({ claimed: 1, rescheduled: 1, erroredIds: [] });
      expect((await betting).balance?.amount).toBe('70.00');
      expect(await transactionRow(rollback.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 2 });

      clock.advance(60_000);
      expect(await worker.runOnce()).toMatchObject({ claimed: 1, processed: 1, erroredIds: [] });
      expect(await balanceOf(wallet)).toBe('100.00');
    });

    it('an expired lease reclaimed by another instance counts the attempt once', async () => {
      const wallet = await open();
      const bet = uuidv7();
      const rollback = await submit(wallet, 'ROLLBACK', uuidv7(), { amount: '30.00', reference: bet });
      const lease = { leaseMs: 5_000 };
      const a = workerWith(lease);
      const b = workerWith(lease, {}, await db.connect());
      clock.advance(2_000);

      const holder = await holdingWallet(wallet.id);
      const roundA = a.runOnce();
      await until(async () => (await lockWaiters()) === 1);
      clock.advance(6_000);
      const roundB = b.runOnce();
      await until(async () => (await lockWaiters()) === 2);
      await holder.release();
      const [first, second] = await Promise.all([roundA, roundB]);

      expect([first.claimed, second.claimed]).toEqual([1, 1]);
      expect(first.rescheduled + second.rescheduled).toBe(1);
      expect(first.skipped + second.skipped).toBe(1);
      expect([...first.erroredIds, ...second.erroredIds]).toEqual([]);
      expect(await transactionRow(rollback.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 2 });

      await submit(wallet, 'BET', bet, { amount: '30.00' });
      clock.advance(60_000);
      expect(await a.runOnce()).toMatchObject({ claimed: 1, processed: 1 });
    });

    it('BET first: the worker sees it committed and settles in the same round', async () => {
      const wallet = await open();
      const bet = uuidv7();
      const rollback = await submit(wallet, 'ROLLBACK', uuidv7(), { amount: '30.00', reference: bet });
      const worker = workerWith();
      clock.advance(2_000);

      const holder = await holdingWallet(wallet.id);
      const betting = submit(wallet, 'BET', bet, { amount: '30.00' });
      await until(async () => (await lockWaiters()) === 1);
      const round = worker.runOnce();
      await until(async () => (await lockWaiters()) === 2);
      await holder.release();

      expect((await betting).balance?.amount).toBe('70.00');
      expect(await round).toMatchObject({ claimed: 1, processed: 1, erroredIds: [] });
      expect(await transactionRow(rollback.transactionId)).toMatchObject({ status: 'PROCESSED' });
      expect(await balanceOf(wallet)).toBe('100.00');
    });
  });
});
