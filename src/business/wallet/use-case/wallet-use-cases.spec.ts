import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { assertEveryFakeWalletConsistent } from '../../../../tests/support/assertions/assert-fake-wallet-consistency';
import { aSubmission, createFakeWageringApp, type FakeWageringApp } from '../../../../tests/support/fakes/fake-wagering-app';
import { InvalidRequestError } from '../../shared/error/invalid-request-error';
import { UniqueConstraintViolationError } from '../../shared/error/unique-constraint-violation-error';
import { WalletNotFoundError } from '../../shared/error/wallet-not-found-error';
import { Money } from '../../shared/value-object/money';
import { Wallet } from '../entity/wallet';
import { WalletAlreadyExistsError } from '../error/wallet-already-exists-error';
import { InvalidLedgerCursorError } from '../error/invalid-ledger-cursor-error';
import { openingIdempotencyKey, SYSTEM_PROVIDER_ID } from './create-wallet/create-wallet';
import { aPlayerId } from '../../../../tests/support/fakes/sequential-id-generator';

const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('wallet use cases', () => {
  let app: FakeWageringApp;

  beforeEach(() => {
    app = createFakeWageringApp();
  });

  afterEach(async () => {
    await assertEveryFakeWalletConsistent(app.db);
  });

  describe('CreateWallet', () => {
    it('opens with a balance: OPENING transaction, CREDIT entry at version 1 and WalletBalanceChanged, atomically', async () => {
      const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('1000.00') });

      expect(wallet).toEqual({ id: expect.any(String), playerId: aPlayerId(1), balance: brl('1000.00'), version: 1 });
      const [opening, ...others] = app.db.wagers.all();
      expect(others).toEqual([]);
      expect(opening?.toState()).toMatchObject({
        providerId: SYSTEM_PROVIDER_ID,
        idempotencyKey: openingIdempotencyKey(wallet.id),
        externalTransactionId: `opening:${wallet.id}`,
        walletId: wallet.id,
        kind: 'OPENING',
        status: 'PROCESSED',
      });
      expect(opening?.observedBalance?.amount).toBe('1000.00');
      const [entry] = await app.db.ledger.listAll(wallet.id);
      expect(entry?.toState()).toMatchObject({ transactionId: opening?.id, entryType: 'OPENING', direction: 'CREDIT', walletVersion: 1 });
      const [event, ...moreEvents] = app.db.outbox.all();
      expect(moreEvents).toEqual([]);
      expect(event?.payload).toMatchObject({
        eventType: 'WalletBalanceChanged',
        aggregateId: wallet.id,
        data: { transactionId: opening?.id, entryType: 'OPENING', balanceAfter: brl('1000.00'), walletVersion: 1 },
      });
    });

    it('carries the caller correlation id on WalletBalanceChanged, defaulting to the wallet id', async () => {
      await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('10.00'), correlationId: 'request-1' });
      const defaulted = await app.createWallet.execute({ playerId: aPlayerId(2), initialBalance: brl('10.00') });
      expect(app.db.outbox.all().map((message) => message.payload.correlationId)).toEqual(['request-1', defaulted.id]);
    });

    it('rejects a playerId with surrounding whitespace', async () => {
      const error = await app.createWallet
        .execute({ playerId: ` ${aPlayerId(1)}`, initialBalance: brl('10.00') })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as InvalidRequestError).field).toBe('playerId');
    });

    it('opens at zero without OPENING, entry or event', async () => {
      const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('0.00') });
      expect(wallet).toMatchObject({ balance: brl('0.00'), version: 1 });
      expect(app.db.wagers.all()).toEqual([]);
      expect(app.db.ledger.count()).toBe(0);
      expect(app.db.outbox.all()).toEqual([]);
    });

    it('refuses a second wallet for the same player and currency, but not another currency', async () => {
      await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('10.00') });
      await expect(
        app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('5.00') }),
      ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
      const usd = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: { amount: '1.00', currency: 'USD' } });
      expect(usd.balance).toEqual({ amount: '1.00', currency: 'USD' });
      expect(app.db.wallets.all()).toHaveLength(2);
      expect(app.db.outbox.all()).toHaveLength(2);
    });

    it('lets exactly one of several concurrent creations win', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('10.00') })),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        results.every((result) => result.status === 'fulfilled' || result.reason instanceof WalletAlreadyExistsError),
      ).toBe(true);
      expect(app.db.wallets.all()).toHaveLength(1);
      expect(app.db.ledger.count()).toBe(1);
    });

    it('maps a lost race on the unique constraint to the wallet conflict and keeps nothing', async () => {
      app.uow.failNext('ledger.append', new UniqueConstraintViolationError('UNIQUE(player_id, currency)'));
      await expect(
        app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('10.00') }),
      ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
      expect(app.db.wallets.all()).toEqual([]);
      expect(app.db.wagers.all()).toEqual([]);
    });

    it.each([
      ['a blank player', { playerId: ' ', initialBalance: brl('1.00') }, 'playerId'],
      ['a player id that is not a UUID', { playerId: 'player-x', initialBalance: brl('1.00') }, 'playerId'],
      ['a malformed amount', { playerId: aPlayerId(1), initialBalance: brl('1.5') }, 'initialBalance'],
      ['a negative amount', { playerId: aPlayerId(1), initialBalance: brl('-1.00') }, 'initialBalance'],
      ['a bad currency', { playerId: aPlayerId(1), initialBalance: { amount: '1.00', currency: 'brl' } }, 'initialBalance'],
    ])('rejects %s as invalid input', async (_name, input, field) => {
      const error = await app.createWallet.execute(input).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(InvalidRequestError);
      expect((error as InvalidRequestError).field).toBe(field);
      expect(app.db.wallets.all()).toEqual([]);
    });
  });

  describe('GetWallet', () => {
    it('returns the current state, or WALLET_NOT_FOUND', async () => {
      const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('100.00') });
      await app.process.execute(aSubmission(wallet, 'BET', 'bet', { amount: '40.00' }));
      expect(await app.getWallet.execute({ walletId: wallet.id })).toEqual({ ...wallet, balance: brl('60.00'), version: 2 });
      await expect(app.getWallet.execute({ walletId: 'ghost' })).rejects.toBeInstanceOf(WalletNotFoundError);
    });
  });

  describe('GetLedger', () => {
    const seed = async (bets: number) => {
      const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('100.00') });
      for (let index = 0; index < bets; index += 1) {
        await app.process.execute(aSubmission(wallet, 'BET', `bet-${index}`, { amount: '1.00' }));
      }
      return wallet;
    };

    it('pages by seq with an opaque cursor, without skipping or repeating while entries keep arriving', async () => {
      const wallet = await seed(4);
      const first = await app.getLedger.execute({ walletId: wallet.id, limit: 2 });
      expect(first.entries.map((entry) => entry.walletVersion)).toEqual([1, 2]);
      expect(first.entries[0]).toMatchObject({ entryType: 'OPENING', direction: 'CREDIT', amount: brl('100.00') });
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

      await app.process.execute(aSubmission(wallet, 'BET', 'late', { amount: '1.00' }));
      const second = await app.getLedger.execute({ walletId: wallet.id, cursor: first.nextCursor, limit: 2 });
      const third = await app.getLedger.execute({ walletId: wallet.id, cursor: second.nextCursor, limit: 2 });
      expect([...second.entries, ...third.entries].map((entry) => entry.walletVersion)).toEqual([3, 4, 5, 6]);
      expect(third.nextCursor).toBeNull();
    });

    it('defaults to 50 entries and returns an empty last page for a wallet without entries', async () => {
      const wallet = await seed(60);
      expect((await app.getLedger.execute({ walletId: wallet.id })).entries).toHaveLength(50);
      const empty = await app.createWallet.execute({ playerId: aPlayerId(2), initialBalance: brl('0.00') });
      expect(await app.getLedger.execute({ walletId: empty.id })).toEqual({ walletId: empty.id, entries: [], nextCursor: null });
    });

    it.each([0, 201, 1.5, Number.NaN])('rejects a limit of %p', async (limit) => {
      const wallet = await seed(0);
      await expect(app.getLedger.execute({ walletId: wallet.id, limit })).rejects.toBeInstanceOf(InvalidRequestError);
    });

    it('rejects a tampered cursor and an unknown wallet', async () => {
      const wallet = await seed(0);
      await expect(app.getLedger.execute({ walletId: wallet.id, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
        InvalidLedgerCursorError,
      );
      await expect(app.getLedger.execute({ walletId: 'ghost' })).rejects.toBeInstanceOf(WalletNotFoundError);
    });
  });

  describe('ReconcileWallet', () => {
    it('reports a consistent wallet', async () => {
      const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('100.00') });
      await app.process.execute(aSubmission(wallet, 'BET', 'bet', { amount: '25.00' }));
      expect(await app.reconcile.execute({ walletId: wallet.id })).toEqual({
        walletId: wallet.id,
        storedBalance: brl('75.00'),
        calculatedBalance: brl('75.00'),
        difference: brl('0.00'),
        consistent: true,
        checkedEntries: 2,
        divergences: [],
      });
    });

    it('flags a divergence without correcting it', async () => {
      const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('100.00') });
      const stored = app.db.wallets.snapshot(wallet.id)!;
      app.db.wallets.write(Wallet.rehydrate({ ...stored, balance: Money.from(brl('90.00')) }));

      const report = await app.reconcile.execute({ walletId: wallet.id });

      expect(report).toMatchObject({
        consistent: false,
        storedBalance: brl('90.00'),
        calculatedBalance: brl('100.00'),
        difference: brl('10.00'),
      });
      expect(report.divergences.map((divergence) => divergence.code)).toContain('BALANCE_MISMATCH');
      expect(app.db.wallets.read(wallet.id)?.balance.amount).toBe('90.00');
      app.db.wallets.restore(wallet.id, stored);
    });

    it('runs in a read-only snapshot and answers WALLET_NOT_FOUND for an unknown wallet', async () => {
      const wallet = await app.createWallet.execute({ playerId: aPlayerId(1), initialBalance: brl('1.00') });
      await app.reconcile.execute({ walletId: wallet.id });
      expect(app.uow.modes.at(-1)).toBe('snapshot-read');
      await expect(app.reconcile.execute({ walletId: 'ghost' })).rejects.toBeInstanceOf(WalletNotFoundError);
    });
  });
});
