import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { IdempotencyConflictError } from '../../../src/business/wagering/error/idempotency-conflict-error';
import type { ProcessWagerTransactionOutput } from '../../../src/business/wagering/use-case/process-wager-transaction/process-wager-transaction.dto';
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

const POOLS = 4;

describe('wager races on PostgreSQL (separate connection pools)', () => {
  let db: WageringDatabase;
  let apps: RealWageringApp[];
  const touched = new Set<string>();

  beforeAll(async () => {
    db = await createWageringDatabase();
    const clock = new FakeClock();
    const orms = [db.orm, ...(await Promise.all(Array.from({ length: POOLS - 1 }, () => db.connect())))];
    apps = orms.map((orm) => createRealWageringApp(orm, { clock }));
  });

  afterEach(() => db.assertConsistent(touched));
  afterAll(() => db?.close());

  const appAt = (index: number): RealWageringApp => apps[index % apps.length]!;

  const open = async (balance: string): Promise<WalletView> => {
    const wallet = await apps[0]!.createWallet.execute({ playerId: uuidv7(), initialBalance: { amount: balance, currency: 'BRL' } });
    touched.add(wallet.id);
    return wallet;
  };

  const submit = (index: number, wallet: WalletView, kind: string, ext: string, options: SubmissionOptions = {}) =>
    appAt(index).process.execute(aSubmission(wallet, kind, ext, options));

  const balanceOf = async (wallet: WalletView): Promise<string> =>
    (await apps[0]!.getWallet.execute({ walletId: wallet.id })).balance.amount;

  const debits = (wallet: WalletView): Promise<number> =>
    countRows(db.sql, 'wallet_ledger_entries', "wallet_id = $1 AND direction = 'DEBIT'", [wallet.id]);

  it('2 × 80.00 over 100.00: one PROCESSED, one REJECTED, balance 20.00 and a single debit', async () => {
    const wallet = await open('100.00');

    const results = await Promise.all([0, 1].map((index) => submit(index, wallet, 'BET', uuidv7(), { amount: '80.00' })));

    expect(results.map((result) => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((result) => result.status === 'REJECTED')).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00' },
    });
    expect(await balanceOf(wallet)).toBe('20.00');
    expect(await debits(wallet)).toBe(1);
  });

  it('30 distinct BETs on one wallet in parallel all settle in turn under the wallet lock, none hits the version guard', async () => {
    const wallet = await open('100.00');

    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, (_, index) => submit(index, wallet, 'BET', uuidv7(), { amount: '1.00' })),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([]);
    const results = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<ProcessWagerTransactionOutput>).value);
    expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    const observed = results.map((result) => result.balance?.amount).sort();
    expect(observed).toEqual(Array.from({ length: 30 }, (_, index) => `${70 + index}.00`).sort());
    expect(await balanceOf(wallet)).toBe('70.00');
    expect(await debits(wallet)).toBe(30);
  });

  it('50 identical BETs in parallel: one PROCESSED and 49 replays of the same transaction and balance', async () => {
    const wallet = await open('1000.00');
    const ext = uuidv7();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => submit(index, wallet, 'BET', ext, { amount: '10.00' })),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    for (const result of results) {
      expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '990.00' } });
    }
    expect(await balanceOf(wallet)).toBe('990.00');
    expect(await debits(wallet)).toBe(1);
  });

  it('the same key on two wallets in parallel: one processed, the other a 409 conflict', async () => {
    const [first, second] = [await open('100.00'), await open('100.00')];
    const ext = uuidv7();

    const outcomes = await Promise.allSettled(
      [first, second].map((wallet, index) => submit(index, wallet, 'BET', ext, { amount: '10.00', key: `key-${ext}` })),
    );

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<ProcessWagerTransactionOutput>).value).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: false,
    });
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyConflictError);
    expect([await balanceOf(first), await balanceOf(second)].sort()).toEqual(['100.00', '90.00']);
  });

  it('wallets never block each other: a held lock on one does not delay the others', async () => {
    const [held, ...others] = await Promise.all(Array.from({ length: 9 }, () => open('100.00')));
    const impatient = createRealWageringApp(db.orm, { lockTimeoutMs: 500 });
    await db.sql.query('BEGIN');
    try {
      await db.sql.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [held!.id]);
      const results = await Promise.all(
        others.map((wallet, index) =>
          (index % 2 === 0 ? impatient : appAt(index)).process.execute(aSubmission(wallet, 'BET', uuidv7(), { amount: '1.00' })),
        ),
      );
      expect(results.every((result) => result.status === 'PROCESSED')).toBe(true);
    } finally {
      await db.sql.query('ROLLBACK');
    }
    for (const wallet of others) expect(await balanceOf(wallet)).toBe('99.00');
  });

  it('REFUND and ROLLBACK of the same BET in parallel: exactly one is PROCESSED', async () => {
    const wallet = await open('100.00');
    const bet = uuidv7();
    await submit(0, wallet, 'BET', bet, { amount: '30.00' });

    const results = await Promise.all([
      submit(1, wallet, 'REFUND', uuidv7(), { amount: '30.00', reference: bet }),
      submit(2, wallet, 'ROLLBACK', uuidv7(), { amount: '30.00', reference: bet }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((result) => result.status === 'REJECTED')?.failureCode).toBe('ALREADY_REVERSED');
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(
      await countRows(db.sql, 'wager_transactions', "wallet_id = $1 AND status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')", [wallet.id]),
    ).toBe(1);
  });
});
