import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { UniqueConstraintViolationError } from '../../../src/business/shared/error/unique-constraint-violation-error';
import { Money } from '../../../src/business/shared/value-object/money';
import { WagerKind } from '../../../src/business/wagering/enum/wager-kind';
import { Wallet } from '../../../src/business/wallet/entity/wallet';
import { WalletAlreadyExistsError } from '../../../src/business/wallet/error/wallet-already-exists-error';
import { LedgerEntryType } from '../../../src/business/wallet/enum/ledger-entry-type';
import { PermanentInfrastructureError } from '../../../src/infrastructure/error/permanent-infrastructure-error';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm/unit-of-work';
import { aProcessedWager, aWager } from '../../support/builders/wager-transaction.builder';
import { uuidv7 } from '../../support/uuid';
import { createRealWageringApp, createWageringDatabase, type RealWageringApp, type WageringDatabase } from './wagering-orm';

const t0 = new Date('2026-07-29T15:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const MAX = '999999999999999999.99';

describe('wallet, ledger and wager transaction repositories (PostgreSQL)', () => {
  let db: WageringDatabase;
  let app: RealWageringApp;
  const touched = new Set<string>();

  beforeAll(async () => {
    db = await createWageringDatabase();
    app = createRealWageringApp(db.orm);
  });

  afterEach(() => db.assertConsistent(touched));
  afterAll(() => db?.close());

  const emptyWallet = async (playerId = uuidv7()): Promise<Wallet> => {
    const { wallet } = Wallet.open({ id: uuidv7(), playerId, initialBalance: brl('0.00'), at: t0 });
    await app.uow.run((tx) => tx.wallets.insert(wallet));
    touched.add(wallet.id);
    return wallet;
  };

  const rejection = (work: Promise<unknown>) => work.then(() => undefined, (error: unknown) => error);

  it('round-trips a wallet with its money as text, up to the numeric(20,2) maximum', async () => {
    const opened = await app.createWallet.execute({ playerId: uuidv7(), initialBalance: { amount: MAX, currency: 'BRL' } });
    touched.add(opened.id);
    const stored = await app.uow.run((tx) => tx.wallets.findById(opened.id));
    expect(stored?.toState()).toMatchObject({ playerId: opened.playerId, version: 1, balance: Money.from({ amount: MAX, currency: 'BRL' }) });
    expect(await app.uow.run((tx) => tx.wallets.existsByPlayerAndCurrency(opened.playerId, 'BRL'))).toBe(true);
    expect(await app.uow.run((tx) => tx.wallets.existsByPlayerAndCurrency(opened.playerId, 'USD'))).toBe(false);
  });

  it('maps the (player, currency) unique violation to WalletAlreadyExistsError', async () => {
    const wallet = await emptyWallet();
    const { wallet: twin } = Wallet.open({ id: uuidv7(), playerId: wallet.playerId, initialBalance: brl('0.00'), at: t0 });
    expect(await rejection(app.uow.run((tx) => tx.wallets.insert(twin)))).toBeInstanceOf(WalletAlreadyExistsError);
  });

  it('reports the constraint of a unique violation on the ledger', async () => {
    const wallet = await emptyWallet();
    const error = await rejection(
      app.uow.run(async (tx) => {
        const locked = (await tx.wallets.lockById(wallet.id))!;
        const win = aWager(WagerKind.WIN, uuidv7(), { id: uuidv7(), walletId: wallet.id, playerId: wallet.playerId });
        const entry = locked.credit({ transactionId: win.id, amount: brl('10.00'), entryType: LedgerEntryType.WIN, at: t0 });
        win.markProcessed(locked.balance, t0);
        await tx.wagers.insert(win);
        await tx.ledger.append(entry);
        await tx.ledger.append(entry);
      }),
    );
    expect(error).toBeInstanceOf(UniqueConstraintViolationError);
    expect((error as UniqueConstraintViolationError).constraint).toBe('wallet_ledger_entries_transaction_unique');
  });

  it('refuses a wallet update from a stale version or that skips a version', async () => {
    const wallet = await emptyWallet();
    const stale = Wallet.rehydrate({ ...wallet.toState(), version: 3, balance: brl('1.00') });
    expect(await rejection(app.uow.run((tx) => tx.wallets.update(stale, 2)))).toBeInstanceOf(PermanentInfrastructureError);
    expect(await rejection(app.uow.run((tx) => tx.wallets.update(stale, 1)))).toBeInstanceOf(PermanentInfrastructureError);
    expect((await app.uow.run((tx) => tx.wallets.findById(wallet.id)))?.version).toBe(1);
  });

  it('round-trips every column of a wager transaction, including a pending one and its update', async () => {
    const wallet = await emptyWallet();
    const pending = aWager(WagerKind.WIN, uuidv7(), {
      id: uuidv7(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      referenceExternalTransactionId: uuidv7(),
      createdAt: t0,
    });
    pending.markPendingReference(new Date(t0.getTime() + 2_000));
    await app.uow.run((tx) => tx.wagers.insert(pending));
    expect((await app.uow.run((tx) => tx.wagers.findById(pending.id)))?.toState()).toEqual(pending.toState());

    const rejectedAt = new Date(t0.getTime() + 5_000);
    await app.uow.run(async (tx) => {
      const locked = (await tx.wagers.lockById(pending.id))!;
      locked.reject('REFERENCE_NOT_FOUND', brl('0.00'), rejectedAt);
      await tx.wagers.update(locked);
    });
    const stored = (await app.uow.run((tx) => tx.wagers.findByIdempotencyKey('provider-1', pending.idempotencyKey)))!;
    expect(stored.toState()).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND', attempts: 1, processedAt: rejectedAt });
    expect(stored.nextAttemptAt).toBeUndefined();
  });

  it('answers null for ids that are not uuids instead of a 22P02', async () => {
    await app.uow.run(async (tx) => {
      expect(await tx.wallets.findById('wallet-1')).toBeNull();
      expect(await tx.wallets.lockById('wallet-1')).toBeNull();
      expect(await tx.wagers.findById('tx-1')).toBeNull();
      expect(await tx.wagers.isReversed('tx-1')).toBe(false);
      expect(await tx.ledger.listAll('wallet-1')).toEqual([]);
    });
  });

  it('refuses an update that would leave a terminal status (trigger, permanent)', async () => {
    const wallet = await emptyWallet();
    const loss = aProcessedWager(WagerKind.LOSS, uuidv7(), { id: uuidv7(), walletId: wallet.id, playerId: wallet.playerId, money: brl('0.00') });
    await app.uow.run((tx) => tx.wagers.insert(loss));
    const tampered = aWager(WagerKind.LOSS, loss.externalTransactionId, { id: loss.id, walletId: wallet.id, playerId: wallet.playerId, money: brl('0.00') });
    tampered.reject('INSUFFICIENT_FUNDS', brl('0.00'), t0);
    const error = await rejection(app.uow.run((tx) => tx.wagers.update(tampered)));
    expect(error).toBeInstanceOf(PermanentInfrastructureError);
    expect((error as PermanentInfrastructureError).sqlState).toBe('23001');
  });

  it('runs snapshot-read units in REPEATABLE READ READ ONLY and the default one in READ COMMITTED', async () => {
    const probe = new MikroOrmUnitOfWork(db.orm.em, (em) => em, { lockTimeoutMs: 1_000 });
    const settingsOf = (mode: 'read-write' | 'snapshot-read') =>
      probe.run(
        async (em) =>
          (
            await em.execute<{ isolation: string; read_only: string }[]>(
              "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
            )
          )[0],
        { mode },
      );
    expect(await settingsOf('read-write')).toEqual({ isolation: 'read committed', read_only: 'off' });
    expect(await settingsOf('snapshot-read')).toEqual({ isolation: 'repeatable read', read_only: 'on' });

    const wallet = await emptyWallet();
    const error = await rejection(
      app.uow.run((tx) => tx.wallets.update(Wallet.rehydrate({ ...wallet.toState(), version: 2 }), 1), { mode: 'snapshot-read' }),
    );
    expect((error as { code?: string }).code).toBe('25006');
  });
});
