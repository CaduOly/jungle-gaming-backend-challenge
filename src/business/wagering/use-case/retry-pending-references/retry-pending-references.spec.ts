import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { assertEveryFakeWalletConsistent } from '../../../../../tests/support/assertions/assert-fake-wallet-consistency';
import {
  aSubmission,
  createFakeWageringApp,
  type FakeWageringApp,
  type SubmissionOptions,
  type WalletView,
} from '../../../../../tests/support/fakes/fake-wagering-app';
import { FailureCode } from '../../../shared/error/failure-code';
import { aPlayerId } from '../../../../../tests/support/fakes/sequential-id-generator';

describe('RetryPendingReferences', () => {
  let app: FakeWageringApp;

  beforeEach(() => {
    app = createFakeWageringApp({ baseMs: 2_000, capMs: 60_000, maxAttempts: 4 });
  });

  afterEach(async () => {
    await assertEveryFakeWalletConsistent(app.db);
  });

  const open = (balance = '100.00', playerId = aPlayerId(1)): Promise<WalletView> =>
    app.createWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' } });
  const submit = (wallet: WalletView, kind: string, ext: string, options: SubmissionOptions = {}) =>
    app.process.execute(aSubmission(wallet, kind, ext, options));
  const balanceOf = (wallet: WalletView): string | undefined => app.db.wallets.read(wallet.id)?.balance.amount;
  const pendingRollback = async (wallet: WalletView, reference = 'bet') =>
    (await submit(wallet, 'ROLLBACK', 'rb', { amount: '30.00', reference })).transactionId;
  const stateOf = (id: string) => app.db.wagers.read(id)?.toState();
  const runAt = (ms: number) => {
    app.clock.advance(ms);
    return app.retry.execute();
  };

  it('does nothing before the next attempt is due', async () => {
    const wallet = await open();
    await pendingRollback(wallet);
    expect(await runAt(999)).toMatchObject({ claimed: 0 });
  });

  it('settles the pending transaction once its reference exists, emitting Processed + WalletBalanceChanged', async () => {
    const wallet = await open();
    const id = await pendingRollback(wallet);
    await submit(wallet, 'BET', 'bet', { amount: '30.00' });
    const before = app.db.outbox.all().length;

    expect(await runAt(1_000)).toEqual({
      claimed: 1,
      processed: 1,
      rejected: 0,
      exhausted: 0,
      rescheduled: 0,
      failed: 0,
      skipped: 0,
      erroredIds: [],
      unattemptedIds: [],
    });

    const settled = app.db.wagers.read(id)!;
    expect(settled.status).toBe('PROCESSED');
    expect(settled.observedBalance?.amount).toBe('100.00');
    expect(settled.referenceTransactionId).toBeDefined();
    expect(balanceOf(wallet)).toBe('100.00');
    expect(app.db.outbox.all().slice(before).map((message) => message.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('reschedules with exponential backoff and no event while the reference is still missing', async () => {
    const wallet = await open();
    const id = await pendingRollback(wallet);
    const before = app.db.outbox.all().length;

    expect(await runAt(1_000)).toMatchObject({ claimed: 1, rescheduled: 1 });
    expect(stateOf(id)).toMatchObject({ attempts: 2 });
    expect(app.db.wagers.read(id)?.nextAttemptAt).toEqual(new Date(app.clock.now().getTime() + 2_000));

    expect(await runAt(1_999)).toMatchObject({ claimed: 0 });
    expect(await runAt(1)).toMatchObject({ claimed: 1, rescheduled: 1 });
    expect(app.db.wagers.read(id)?.attempts).toBe(3);
    expect(app.db.wagers.read(id)?.nextAttemptAt).toEqual(new Date(app.clock.now().getTime() + 4_000));
    expect(app.db.outbox.all()).toHaveLength(before);
  });

  it('rejects with REFERENCE_NOT_FOUND and publishes the rejection when the attempts run out', async () => {
    const wallet = await open();
    const id = await pendingRollback(wallet);
    await runAt(1_000);
    await runAt(2_000);
    expect(await runAt(4_000)).toMatchObject({ claimed: 1, exhausted: 1, rejected: 0 });

    const rejected = app.db.wagers.read(id)!;
    expect(stateOf(id)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND', attempts: 3 });
    expect(rejected.observedBalance?.amount).toBe('100.00');
    const event = app.db.outbox.all().at(-1);
    expect(event?.eventType).toBe('WagerTransactionRejected');
    expect(event?.payload.data).toMatchObject({ transactionId: id, failureCode: 'REFERENCE_NOT_FOUND' });

    expect(await runAt(60_000)).toMatchObject({ claimed: 0 });
    const replay = await submit(wallet, 'ROLLBACK', 'rb', { amount: '30.00', reference: 'bet' });
    expect(replay).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND', idempotentReplay: true });

    const late = await submit(wallet, 'BET', 'bet', { amount: '30.00' });
    expect(late.status).toBe('PROCESSED');
    expect(balanceOf(wallet)).toBe('70.00');
  });

  it('runs out with REFERENCE_NOT_PROCESSED when the reference exists but itself stays pending', async () => {
    const wallet = await open();
    const winId = (await submit(wallet, 'WIN', 'win', { amount: '30.00', reference: 'bet' })).transactionId;
    app.db.wagers.rows.get(winId)!.state.nextAttemptAt = new Date(app.clock.now().getTime() + 3_600_000);
    const id = (await submit(wallet, 'ROLLBACK', 'rb', { amount: '30.00', reference: 'win' })).transactionId;
    expect(await runAt(1_000)).toMatchObject({ claimed: 1, rescheduled: 1 });
    expect(await runAt(2_000)).toMatchObject({ claimed: 1, rescheduled: 1 });
    expect(await runAt(4_000)).toMatchObject({ claimed: 1, exhausted: 1, rejected: 0 });
    expect(stateOf(id)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED', attempts: 3 });
    expect(stateOf(winId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });
  });

  it('rejects with BALANCE_LIMIT_EXCEEDED, like the main flow, when the credit would pass the Money maximum', async () => {
    const wallet = await open('999999999999999999.99');
    const id = (await submit(wallet, 'WIN', 'win', { amount: '1.00', reference: 'bet' })).transactionId;
    await submit(wallet, 'BET', 'bet', { amount: '0.50' });

    expect(await runAt(1_000)).toMatchObject({ claimed: 1, rejected: 1, failed: 0, processed: 0, erroredIds: [] });

    expect(stateOf(id)).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.BALANCE_LIMIT_EXCEEDED });
    expect(app.db.wagers.read(id)?.observedBalance?.amount).toBe('999999999999999999.49');
    expect(balanceOf(wallet)).toBe('999999999999999999.49');
    const event = app.db.outbox.all().at(-1);
    expect(event?.eventType).toBe('WagerTransactionRejected');
    expect(event?.payload.data).toMatchObject({ transactionId: id, failureCode: FailureCode.BALANCE_LIMIT_EXCEEDED });
    expect(await runAt(60_000)).toMatchObject({ claimed: 0 });
  });

  it('correlates the events of a settled retry by the transaction id', async () => {
    const wallet = await open();
    const id = (
      await submit(wallet, 'ROLLBACK', 'rb', { amount: '30.00', reference: 'bet', correlationId: 'request-1' })
    ).transactionId;
    await submit(wallet, 'BET', 'bet', { amount: '30.00' });
    const before = app.db.outbox.all().length;
    await runAt(1_000);
    const events = app.db.outbox.all().slice(before);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.payload.correlationId).toBe(id);
  });

  it('rejects at once when the reference shows up rejected or failing a policy', async () => {
    const wallet = await open('10.00');
    const id = await pendingRollback(wallet);
    await submit(wallet, 'BET', 'bet', { amount: '30.00' });
    expect(await runAt(1_000)).toMatchObject({ rejected: 1 });
    expect(stateOf(id)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_PROCESSED' });
    expect(app.db.outbox.all().at(-1)?.eventType).toBe('WagerTransactionRejected');
  });

  it('rejects with REVERSAL_INSUFFICIENT_FUNDS when settling would overdraw', async () => {
    const wallet = await open('10.00');
    const id = (await submit(wallet, 'ROLLBACK', 'rb', { amount: '50.00', reference: 'win' })).transactionId;
    await submit(wallet, 'BET', 'bet', { amount: '10.00' });
    await submit(wallet, 'WIN', 'win', { amount: '50.00', reference: 'bet' });
    await submit(wallet, 'BET', 'drain', { amount: '45.00' });
    expect(await runAt(1_000)).toMatchObject({ rejected: 1 });
    expect(stateOf(id)).toMatchObject({ failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });
    expect(balanceOf(wallet)).toBe('5.00');
  });

  it('locks the wallet before the transaction, like the main flow', async () => {
    const wallet = await open();
    await pendingRollback(wallet);
    const order: string[] = [];
    app.uow.before('wallets.lockById', () => void order.push('wallet'));
    app.uow.before('wagers.lockById', () => void order.push('transaction'));
    await runAt(1_000);
    expect(order).toEqual(['wallet', 'transaction']);
  });

  it('skips a transaction that someone else decided between the claim and the lock', async () => {
    const wallet = await open();
    const id = await pendingRollback(wallet);
    app.uow.before(
      'wallets.lockById',
      async () => {
        const other = new (app.uow.constructor as typeof import('../../../../../tests/support/fakes/fake-unit-of-work').FakeUnitOfWork)(app.db);
        await other.run(async (tx) => {
          const locked = await tx.wallets.lockById(wallet.id);
          const transaction = (await tx.wagers.lockById(id))!;
          transaction.reject(FailureCode.REFERENCE_NOT_FOUND, locked!.balance, app.clock.now());
          await tx.wagers.update(transaction);
        });
      },
      1,
    );
    expect(await runAt(1_000)).toMatchObject({ claimed: 1, skipped: 1 });
  });

  it('skips an attempt another instance already counted after this claim (an expired lease is reclaimed)', async () => {
    const wallet = await open();
    const id = await pendingRollback(wallet);
    app.uow.before(
      'wallets.lockById',
      async () => {
        const other = new (app.uow.constructor as typeof import('../../../../../tests/support/fakes/fake-unit-of-work').FakeUnitOfWork)(app.db);
        await other.run(async (tx) => {
          await tx.wallets.lockById(wallet.id);
          const transaction = (await tx.wagers.lockById(id))!;
          transaction.scheduleNextAttempt(new Date(app.clock.now().getTime() + 4_000));
          await tx.wagers.update(transaction);
        });
        // Quando essa instância pega o lock, a nova tentativa da outra também já venceu, então só o horário do claim
        // mostra que essa tentativa já foi contada.
        app.clock.advance(5_000);
      },
      1,
    );
    expect(await runAt(1_000)).toMatchObject({ claimed: 1, skipped: 1, rescheduled: 0 });
    expect(stateOf(id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 2 });
  });

  it('moves the transaction to FAILED when its wallet is gone (permanent inconsistency)', async () => {
    const wallet = await open();
    const id = await pendingRollback(wallet);
    const snapshot = app.db.wallets.snapshot(wallet.id);
    app.db.wallets.restore(wallet.id, undefined);
    expect(await runAt(1_000)).toMatchObject({ failed: 1 });
    expect(stateOf(id)).toMatchObject({ status: 'FAILED', failureCode: 'WALLET_NOT_FOUND' });
    app.db.wallets.restore(wallet.id, snapshot);
  });

  it('keeps an item that errored pending and retries it after the lease', async () => {
    const wallet = await open();
    const id = await pendingRollback(wallet);
    await submit(wallet, 'BET', 'bet', { amount: '30.00' });
    app.uow.failNext('ledger.append');
    expect(await runAt(1_000)).toMatchObject({ claimed: 1, processed: 0, erroredIds: [id] });
    expect(stateOf(id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });
    expect(balanceOf(wallet)).toBe('70.00');

    expect(await runAt(1_000)).toMatchObject({ claimed: 0 });
    expect(await runAt(30_000)).toMatchObject({ claimed: 1, processed: 1 });
    expect(balanceOf(wallet)).toBe('100.00');
  });

  it('stops between items when asked: the ones it did not reach keep their attempts and wait for the lease', async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, (_, i) => open('100.00', aPlayerId(i))));
    const ids: string[] = [];
    for (const wallet of wallets) ids.push((await submit(wallet, 'ROLLBACK', `${wallet.id}-rb`, { amount: '30.00', reference: 'gone' })).transactionId);
    let checks = 0;
    app.clock.advance(1_000);

    const output = await app.retry.execute({ shouldStop: () => ++checks > 1 });

    expect(output).toMatchObject({ claimed: 3, rescheduled: 1, erroredIds: [] });
    expect(output.unattemptedIds).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([...output.unattemptedIds]));
    for (const id of output.unattemptedIds) expect(stateOf(id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });
    expect(await app.retry.execute()).toMatchObject({ claimed: 0 });
    expect(await runAt(30_000)).toMatchObject({ claimed: 3, unattemptedIds: [] });
  });

  it('two workers in parallel never process the same item twice', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, (_, i) => open('100.00', aPlayerId(i))));
    for (const wallet of wallets) {
      await submit(wallet, 'REFUND', `${wallet.id}-refund`, { amount: '30.00', reference: `${wallet.id}-bet` });
      await submit(wallet, 'BET', `${wallet.id}-bet`, { amount: '30.00' });
    }
    app.clock.advance(1_000);
    const [a, b] = await Promise.all([app.retry.execute(), app.retry.execute()]);
    expect(a!.processed + b!.processed).toBe(4);
    expect(a!.claimed + b!.claimed).toBe(4);
    expect(wallets.map(balanceOf)).toEqual(wallets.map(() => '100.00'));
  });
});
