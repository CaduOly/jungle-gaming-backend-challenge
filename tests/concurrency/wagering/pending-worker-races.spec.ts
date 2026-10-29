import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { RetryPendingReferencesOutput } from '../../../src/business/wagering/use-case/retry-pending-references/retry-pending-references';
import { DEFAULT_PENDING_REFERENCE_WORKER_CONFIG } from '../../../src/infrastructure/config/pending-reference-worker-config';
import { UuidV7IdGenerator } from '../../../src/infrastructure/id/uuid-v7-id-generator';
import type { PendingReferenceWorker } from '../../../src/infrastructure/wagering/pending-reference-worker';
import { createPendingReferenceWorker } from '../../../src/infrastructure/wagering/pending-reference-worker.factory';
import { FakeClock } from '../../support/fakes/fake-clock';
import { aSubmission, type SubmissionOptions, type WalletView } from '../../support/fakes/fake-wagering-app';
import { uuidv7 } from '../../support/uuid';
import {
  countRows,
  createRealWageringApp,
  createWageringDatabase,
  type RealWageringApp,
  type WageringDatabase,
} from '../../integration/persistence/wagering-orm';

const WORKERS = 3;
const WALLETS = 8;

const until = async (condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
};

const sum = (outputs: RetryPendingReferencesOutput[], field: 'claimed' | 'processed' | 'rescheduled' | 'skipped'): number =>
  outputs.reduce((total, output) => total + output[field], 0);

describe('pending reference workers racing on PostgreSQL (one ORM and pool each)', () => {
  let db: WageringDatabase;
  let app: RealWageringApp;
  let orms: MikroORM[];
  const clock = new FakeClock();
  const touched = new Set<string>();
  let workers: PendingReferenceWorker[] = [];

  beforeAll(async () => {
    db = await createWageringDatabase();
    app = createRealWageringApp(db.orm, { clock });
    orms = await Promise.all(Array.from({ length: WORKERS }, () => db.connect()));
  });

  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.stop()));
    workers = [];
    await db.assertConsistent(touched);
  });

  afterAll(() => db?.close());

  const open = async (): Promise<WalletView> => {
    const wallet = await app.createWallet.execute({ playerId: uuidv7(), initialBalance: { amount: '1000.00', currency: 'BRL' } });
    touched.add(wallet.id);
    return wallet;
  };
  const submit = (wallet: WalletView, kind: string, ext: string, options: SubmissionOptions = {}) =>
    app.process.execute(aSubmission(wallet, kind, ext, options));

  it(`${WORKERS} workers over many pendings on shared wallets: each attempt runs once, no deadlock, nothing errors`, async () => {
    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => open()));
    const resolvable: string[] = [];
    const missing: string[] = [];
    await Promise.all(
      wallets.map(async (wallet) => {
        for (const _ of [1, 2]) {
          const bet = uuidv7();
          resolvable.push((await submit(wallet, 'REFUND', uuidv7(), { amount: '10.00', reference: bet })).transactionId);
          await submit(wallet, 'BET', bet, { amount: '10.00' });
        }
        missing.push((await submit(wallet, 'ROLLBACK', uuidv7(), { amount: '5.00', reference: uuidv7() })).transactionId);
      }),
    );
    clock.advance(2_000);

    const outputs: RetryPendingReferencesOutput[] = [];
    const errors: unknown[] = [];
    workers = orms.map((orm) =>
      createPendingReferenceWorker({
        em: orm.em,
        clock,
        ids: new UuidV7IdGenerator(),
        config: { ...DEFAULT_PENDING_REFERENCE_WORKER_CONFIG, batchSize: 3, pollIntervalMs: 5 },
        lockTimeoutMs: 2_000,
        random: () => 0,
        onRound: (output) => outputs.push(output),
        onError: (error) => errors.push(error),
      }),
    );
    for (const worker of workers) worker.start();
    const meanwhile = Promise.all(wallets.map((wallet) => submit(wallet, 'BET', uuidv7(), { amount: '1.00' })));

    const total = resolvable.length + missing.length;
    await until(async () => sum(outputs, 'processed') + sum(outputs, 'rescheduled') >= total);
    await meanwhile;
    await Promise.all(workers.map((worker) => worker.stop()));

    expect(errors).toEqual([]);
    expect(outputs.flatMap((output) => output.erroredIds)).toEqual([]);
    expect(sum(outputs, 'claimed')).toBe(total);
    expect(sum(outputs, 'processed')).toBe(resolvable.length);
    expect(sum(outputs, 'rescheduled')).toBe(missing.length);
    expect(sum(outputs, 'skipped')).toBe(0);

    const statuses = await db.sql.query<{ status: string; attempts: number; total: number }>(
      `SELECT status, attempts, count(*)::int AS total FROM wager_transactions WHERE id = ANY($1::uuid[])
        GROUP BY status, attempts ORDER BY status`,
      [[...resolvable, ...missing]],
    );
    expect(statuses.rows).toEqual([
      { status: 'PENDING_REFERENCE', attempts: 2, total: missing.length },
      { status: 'PROCESSED', attempts: 1, total: resolvable.length },
    ]);
    expect(await countRows(db.sql, 'wallet_ledger_entries', 'transaction_id = ANY($1::uuid[])', [resolvable])).toBe(
      resolvable.length,
    );
    for (const wallet of wallets) {
      expect((await app.getWallet.execute({ walletId: wallet.id })).balance.amount).toBe('999.00');
    }
  });
});
