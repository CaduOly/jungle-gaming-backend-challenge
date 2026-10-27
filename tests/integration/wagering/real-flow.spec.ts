import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { IdempotencyConflictError } from '../../../src/business/wagering/error/idempotency-conflict-error';
import { TransientInfrastructureError } from '../../../src/infrastructure/error/transient-infrastructure-error';
import { FaultInjector, InjectedFaultError, type FaultPoint } from '../../../src/infrastructure/fault-injection/fault-injector';
import { aSubmission, type SubmissionOptions, type WalletView } from '../../support/fakes/fake-wagering-app';
import { uuidv7 } from '../../support/uuid';
import { countRows, createRealWageringApp, createWageringDatabase, type RealWageringApp, type WageringDatabase } from '../persistence/wagering-orm';

describe('ProcessWagerTransaction over the real PostgreSQL repositories', () => {
  let db: WageringDatabase;
  let app: RealWageringApp;
  const wallets = new Set<string>();

  beforeAll(async () => {
    db = await createWageringDatabase();
    app = createRealWageringApp(db.orm);
  });

  afterEach(async () => {
    await db.assertConsistent(wallets);
  });

  afterAll(() => db?.close());

  const open = async (balance = '1000.00', target: RealWageringApp = app): Promise<WalletView> => {
    const wallet = await target.createWallet.execute({ playerId: uuidv7(), initialBalance: { amount: balance, currency: 'BRL' } });
    wallets.add(wallet.id);
    return wallet;
  };
  const submit = (wallet: WalletView, kind: string, ext: string, options: SubmissionOptions = {}, target = app) =>
    target.process.execute(aSubmission(wallet, kind, ext, options));
  const balanceOf = async (wallet: WalletView): Promise<string> => (await app.getWallet.execute({ walletId: wallet.id })).balance.amount;

  const footprint = async (walletId: string) => {
    const [wallet] = (await db.sql.query('SELECT balance, version FROM wallets WHERE id = $1', [walletId])).rows;
    return {
      wallet,
      transactions: await countRows(db.sql, 'wager_transactions', 'wallet_id = $1', [walletId]),
      ledger: await countRows(db.sql, 'wallet_ledger_entries', 'wallet_id = $1', [walletId]),
      outbox: await countRows(db.sql, 'outbox_messages', 'aggregate_id = $1 OR payload::text LIKE $2', [walletId, `%${walletId}%`]),
    };
  };

  describe('atomicity', () => {
    it.each<FaultPoint>(['fail_outbox_insert', 'fail_ledger_insert', 'crash_before_commit'])(
      '%s leaves wallet, transactions, ledger and outbox exactly as they were',
      async (point) => {
        const wallet = await open('100.00');
        const before = await footprint(wallet.id);
        const faulty = createRealWageringApp(db.orm, { faults: FaultInjector.of(point) });

        const error = await submit(wallet, 'BET', uuidv7(), { amount: '30.00' }, faulty).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(InjectedFaultError);
        expect(await footprint(wallet.id)).toEqual(before);
        expect(before).toMatchObject({ wallet: { balance: '100.00', version: 1 }, transactions: 1, ledger: 1, outbox: 1 });
      },
    );
  });

  it('historical replay: the first BET still answers 975.00 after the balance moved to 950.00', async () => {
    const wallet = await open();
    const first = await submit(wallet, 'BET', 'bet-1', { amount: '25.00' });
    const second = await submit(wallet, 'BET', 'bet-2', { amount: '25.00' });
    const replay = await submit(wallet, 'BET', 'bet-1', { amount: '25.00' });
    expect(first.balance?.amount).toBe('975.00');
    expect(second.balance?.amount).toBe('950.00');
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(await balanceOf(wallet)).toBe('950.00');
  });

  it('a ROLLBACK before its BET stays pending; RetryPendingReferences settles it once the BET arrives', async () => {
    const wallet = await open('100.00');
    const rollback = await submit(wallet, 'ROLLBACK', 'rb', { amount: '30.00', reference: 'bet' });
    expect(rollback).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });

    expect((await submit(wallet, 'BET', 'bet', { amount: '30.00' })).balance?.amount).toBe('70.00');
    app.clock.advance(2_000);
    expect(await app.retry.execute()).toMatchObject({ claimed: 1, processed: 1, erroredIds: [] });

    expect(await app.getTransaction.execute({ transactionId: rollback.transactionId })).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00' },
      referenceTransactionId: expect.any(String),
    });
    expect(await balanceOf(wallet)).toBe('100.00');
    expect(await app.retry.execute()).toMatchObject({ claimed: 0 });
  });

  it('persists a CURRENCY_MISMATCH rejection (wallet_currency is NULL) and replays it as 422, not a 500', async () => {
    const wallet = await open('100.00');
    const rejected = await submit(wallet, 'BET', 'usd-bet', { amount: '10.00', currency: 'USD' });
    expect(rejected).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: { amount: '100.00', currency: 'BRL' } });

    const { rows } = await db.sql.query(
      'SELECT currency, wallet_currency, processed_at FROM wager_transactions WHERE id = $1',
      [rejected.transactionId],
    );
    expect(rows).toEqual([{ currency: 'USD', wallet_currency: null, processed_at: null }]);
    expect(await submit(wallet, 'BET', 'usd-bet', { amount: '10.00', currency: 'USD' })).toEqual({ ...rejected, idempotentReplay: true });
    expect(await app.getTransaction.execute({ transactionId: rejected.transactionId })).toMatchObject({
      money: { amount: '10.00', currency: 'USD' },
      balance: { amount: '100.00', currency: 'BRL' },
      processedAt: app.clock.now().toISOString(),
    });
  });

  it('persists a WALLET_PLAYER_MISMATCH rejection with the player the provider sent', async () => {
    const wallet = await open('100.00');
    const stranger = uuidv7();
    const rejected = await submit(wallet, 'BET', 'stranger', { playerId: stranger });
    expect(rejected).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    const { rows } = await db.sql.query('SELECT player_id, wallet_player_id FROM wager_transactions WHERE id = $1', [rejected.transactionId]);
    expect(rows).toEqual([{ player_id: stranger, wallet_player_id: null }]);
    expect(await submit(wallet, 'BET', 'stranger', { playerId: stranger })).toEqual({ ...rejected, idempotentReplay: true });
  });

  it('answers IDEMPOTENCY_CONFLICT for the same key with another payload', async () => {
    const wallet = await open();
    await submit(wallet, 'BET', 'tx', { amount: '25.00' });
    await expect(submit(wallet, 'BET', 'tx', { amount: '25.01' })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('turns a real lock timeout on the wallet into a TransientInfrastructureError and writes nothing', async () => {
    const wallet = await open('100.00');
    const impatient = createRealWageringApp(db.orm, { lockTimeoutMs: 200 });
    await db.sql.query('BEGIN');
    try {
      await db.sql.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
      const error = await submit(wallet, 'BET', 'blocked', { amount: '10.00' }, impatient).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as TransientInfrastructureError).sqlState).toBe('55P03');
    } finally {
      await db.sql.query('ROLLBACK');
    }
    expect(await countRows(db.sql, 'wager_transactions', 'wallet_id = $1 AND kind <> $2', [wallet.id, 'OPENING'])).toBe(0);
    expect((await submit(wallet, 'BET', 'blocked', { amount: '10.00' })).status).toBe('PROCESSED');
  });

  it('serves the readers outside any unit of work: wallet, ledger pages by cursor and transactions', async () => {
    const wallet = await open('100.00');
    for (const ext of ['b1', 'b2', 'b3']) await submit(wallet, 'BET', ext, { amount: '1.00' });
    const first = await app.getLedger.execute({ walletId: wallet.id, limit: 2 });
    expect(first.entries.map((entry) => entry.balanceAfter.amount)).toEqual(['100.00', '99.00']);
    const second = await app.getLedger.execute({ walletId: wallet.id, limit: 2, cursor: first.nextCursor });
    expect(second.entries.map((entry) => entry.balanceAfter.amount)).toEqual(['98.00', '97.00']);
    expect(second.nextCursor).toBeNull();
    const byExternal = await app.getTransaction.execute({ providerId: 'provider-a', externalTransactionId: 'b2' });
    expect(byExternal).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '1.00', currency: 'BRL' } });
    await expect(app.getWallet.execute({ walletId: 'not-a-uuid' })).rejects.toMatchObject({ name: 'WalletNotFoundError' });
    expect(await app.reconcile.execute({ walletId: wallet.id })).toMatchObject({ consistent: true, checkedEntries: 4 });
  });
});
