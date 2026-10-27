import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { UniqueConstraintViolationError } from '../../../src/business/shared/error/unique-constraint-violation-error';
import { Money } from '../../../src/business/shared/value-object/money';
import type { WagerTransaction } from '../../../src/business/wagering/entity/wager-transaction';
import { WagerKind } from '../../../src/business/wagering/enum/wager-kind';
import type { IWageringUnitOfWork, TxRepositories } from '../../../src/business/wagering/port/tx-repositories.port';
import { Wallet } from '../../../src/business/wallet/entity/wallet';
import { LedgerEntryType } from '../../../src/business/wallet/enum/ledger-entry-type';
import { aProcessedWager, aWager } from '../builders/wager-transaction.builder';
import { uuidv7 } from '../uuid';

export interface WageringRepositoriesHarness {
  readonly uow: IWageringUnitOfWork;
  /** Checks balance against ledger for every wallet the test touched (assertWalletConsistency or its fake twin). */
  readonly assertConsistent: (walletIds: readonly string[]) => Promise<void>;
  readonly teardown?: () => Promise<void>;
}

const t0 = new Date('2026-07-29T15:00:00.000Z');
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const LEASE_MS = 30_000;

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

const within = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms)),
  ]);

const rejectionOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

/**
 * Concurrency semantics every TxRepositories implementation must share: the wallet row lock, the unique
 * constraints behind idempotency and the SKIP LOCKED claim of pending references.
 */
export const describeWageringRepositoriesContract = (
  name: string,
  setup: () => Promise<WageringRepositoriesHarness>,
): void => {
  describe(`TxRepositories concurrency contract: ${name}`, () => {
    let harness: WageringRepositoriesHarness;
    let uow: IWageringUnitOfWork;
    let touched: string[];

    beforeEach(async () => {
      harness = await setup();
      uow = harness.uow;
      touched = [];
    });

    afterEach(async () => {
      await harness.assertConsistent(touched);
      await harness.teardown?.();
    });

    const openWallet = async (balance = '0.00'): Promise<Wallet> => {
      const { wallet } = Wallet.open({ id: uuidv7(), playerId: uuidv7(), initialBalance: brl(balance), at: t0 });
      await uow.run((tx) => tx.wallets.insert(wallet));
      touched.push(wallet.id);
      return wallet;
    };

    const wagerOf = (wallet: Wallet, kind: WagerKind, ext = uuidv7(), overrides: Parameters<typeof aWager>[2] = {}) =>
      aWager(kind, ext, { id: uuidv7(), walletId: wallet.id, playerId: wallet.playerId, ...overrides });

    const processedOf = (wallet: Wallet, kind: WagerKind, ext = uuidv7(), overrides: Parameters<typeof aWager>[2] = {}) =>
      aProcessedWager(kind, ext, { id: uuidv7(), walletId: wallet.id, playerId: wallet.playerId, ...overrides });

    /** A processed WIN with its CREDIT entry and the wallet update, under the wallet lock. */
    const creditWin = async (tx: TxRepositories, walletId: string, amount: string): Promise<Wallet> => {
      const wallet = (await tx.wallets.lockById(walletId))!;
      const expectedVersion = wallet.version;
      const win = wagerOf(wallet, WagerKind.WIN, uuidv7(), { money: brl(amount) });
      const entry = wallet.credit({ transactionId: win.id, amount: brl(amount), entryType: LedgerEntryType.WIN, at: t0 });
      win.markProcessed(wallet.balance, t0);
      await tx.wagers.insert(win);
      await tx.ledger.append(entry);
      await tx.wallets.update(wallet, expectedVersion);
      return wallet;
    };

    const pendingOf = (wallet: Wallet, nextAttemptAt: Date): WagerTransaction => {
      const pending = wagerOf(wallet, WagerKind.ROLLBACK, uuidv7(), { referenceExternalTransactionId: uuidv7() });
      pending.markPendingReference(nextAttemptAt);
      return pending;
    };

    describe('wallet lock', () => {
      it('makes a second lock wait until the holder commits, then hands it the committed row', async () => {
        const wallet = await openWallet();
        const order: string[] = [];
        const held = deferred();
        const release = deferred();

        const holder = uow.run(async (tx) => {
          await tx.wallets.lockById(wallet.id);
          held.resolve();
          await release.promise;
          await creditWin(tx, wallet.id, '10.00');
          order.push('holder-done');
        });
        await held.promise;
        const waiter = uow.run(async (tx) => {
          const locked = await tx.wallets.lockById(wallet.id);
          order.push('waiter-locked');
          return locked;
        });

        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(order).toEqual([]);
        release.resolve();
        const [, seen] = await Promise.all([holder, waiter]);

        expect(order).toEqual(['holder-done', 'waiter-locked']);
        expect(seen?.balance.amount).toBe('10.00');
        expect(seen?.version).toBe(2);
      });

      it('releases the lock on rollback without applying anything', async () => {
        const wallet = await openWallet();
        const failure = new Error('rolled back on purpose');
        const error = await rejectionOf(
          uow.run(async (tx) => {
            await creditWin(tx, wallet.id, '10.00');
            throw failure;
          }),
        );
        expect(error).toBe(failure);
        const after = await within(uow.run((tx) => tx.wallets.lockById(wallet.id)), 1_000, 'the lock after a rollback');
        expect(after?.toState()).toMatchObject({ version: 1, balance: brl('0.00') });
      });

      it('never blocks on the lock of another wallet', async () => {
        const [first, second] = [await openWallet(), await openWallet()];
        const firstHeld = deferred();
        const secondHeld = deferred();

        const a = uow.run(async (tx) => {
          await tx.wallets.lockById(first.id);
          firstHeld.resolve();
          await within(secondHeld.promise, 2_000, 'locking the other wallet');
        });
        await firstHeld.promise;
        const b = uow.run(async (tx) => {
          await tx.wallets.lockById(second.id);
          secondHeld.resolve();
        });

        await Promise.all([a, b]);
      });

      it('returns null for an unknown wallet', async () => {
        expect(await uow.run((tx) => tx.wallets.lockById(uuidv7()))).toBeNull();
      });
    });

    describe('idempotency constraints', () => {
      it('rejects a second (provider, idempotency key) with UniqueConstraintViolationError', async () => {
        const wallet = await openWallet();
        const [key, second] = [uuidv7(), uuidv7()];
        await uow.run((tx) => tx.wagers.insert(processedOf(wallet, WagerKind.LOSS, uuidv7(), { idempotencyKey: key, money: brl('0.00') })));
        const error = await rejectionOf(
          uow.run((tx) => tx.wagers.insert(processedOf(wallet, WagerKind.LOSS, second, { idempotencyKey: key, money: brl('0.00') }))),
        );
        expect(error).toBeInstanceOf(UniqueConstraintViolationError);
        expect(await uow.run((tx) => tx.wagers.findByExternalId('provider-1', second))).toBeNull();
      });

      it('rejects a second (provider, external id) under another key', async () => {
        const wallet = await openWallet();
        const ext = uuidv7();
        await uow.run((tx) => tx.wagers.insert(processedOf(wallet, WagerKind.LOSS, ext, { idempotencyKey: uuidv7(), money: brl('0.00') })));
        const error = await rejectionOf(
          uow.run((tx) => tx.wagers.insert(processedOf(wallet, WagerKind.LOSS, ext, { idempotencyKey: uuidv7(), money: brl('0.00') }))),
        );
        expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      });

      it('scopes both constraints by provider', async () => {
        const wallet = await openWallet();
        const [ext, key] = [uuidv7(), uuidv7()];
        for (const providerId of ['provider-1', 'provider-2']) {
          await uow.run((tx) => tx.wagers.insert(processedOf(wallet, WagerKind.LOSS, ext, { providerId, idempotencyKey: key, money: brl('0.00') })));
        }
        expect((await uow.run((tx) => tx.wagers.findByIdempotencyKey('provider-2', key)))?.providerId).toBe('provider-2');
      });

      it('lets exactly one of two concurrent units insert the same key, even on different wallets', async () => {
        const [first, second] = [await openWallet(), await openWallet()];
        const key = uuidv7();
        const outcomes = await Promise.allSettled(
          [first, second].map((wallet) =>
            uow.run((tx) =>
              tx.wagers.insert(processedOf(wallet, WagerKind.LOSS, uuidv7(), { idempotencyKey: key, money: brl('0.00') })),
            ),
          ),
        );
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        const [failed] = outcomes.filter((outcome) => outcome.status === 'rejected');
        expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(UniqueConstraintViolationError);
      });

      it('allows a single processed reversal per reference and reports it through isReversed', async () => {
        const wallet = await openWallet();
        const bet = processedOf(wallet, WagerKind.BET, uuidv7());
        await uow.run((tx) => tx.wagers.insert(bet));
        expect(await uow.run((tx) => tx.wagers.isReversed(bet.id))).toBe(false);

        const reversal = (kind: WagerKind) => {
          const transaction = wagerOf(wallet, kind, uuidv7(), { referenceExternalTransactionId: bet.externalTransactionId });
          transaction.attachReference(bet);
          transaction.markProcessed(brl('100.00'), t0);
          return transaction;
        };
        await uow.run((tx) => tx.wagers.insert(reversal(WagerKind.REFUND)));
        expect(await uow.run((tx) => tx.wagers.isReversed(bet.id))).toBe(true);

        const error = await rejectionOf(uow.run((tx) => tx.wagers.insert(reversal(WagerKind.ROLLBACK))));
        expect(error).toBeInstanceOf(UniqueConstraintViolationError);
      });
    });

    describe('claim of pending references', () => {
      it('leases only due, unleased PENDING_REFERENCE ids, oldest first, until the lease ends or an update releases it', async () => {
        const wallet = await openWallet();
        const [late, early, future] = [pendingOf(wallet, at(20)), pendingOf(wallet, at(10)), pendingOf(wallet, at(LEASE_MS * 10))];
        const processed = processedOf(wallet, WagerKind.LOSS, uuidv7(), { money: brl('0.00') });
        await uow.run(async (tx) => {
          for (const transaction of [late, early, future, processed]) await tx.wagers.insert(transaction);
        });
        const claim = (now: Date, limit = 10) => uow.run((tx) => tx.wagers.claimPendingBatch({ limit, leaseMs: LEASE_MS, now }));

        expect(await claim(at(100), 1)).toEqual([early.id]);
        expect(await claim(at(100))).toEqual([late.id]);
        expect(await claim(at(LEASE_MS))).toEqual([]);
        expect(await claim(at(100 + LEASE_MS))).toEqual([early.id, late.id]);

        await uow.run(async (tx) => {
          const locked = (await tx.wagers.lockById(early.id))!;
          locked.scheduleNextAttempt(at(200 + LEASE_MS));
          await tx.wagers.update(locked);
        });
        expect(await claim(at(200 + LEASE_MS))).toEqual([early.id]);
      });

      it('never hands the same id to concurrent claimers', async () => {
        const wallet = await openWallet();
        const pending = Array.from({ length: 30 }, (_, index) => pendingOf(wallet, at(index)));
        await uow.run(async (tx) => {
          for (const transaction of pending) await tx.wagers.insert(transaction);
        });

        const batches = await Promise.all(
          Array.from({ length: 4 }, () =>
            uow.run((tx) => tx.wagers.claimPendingBatch({ limit: 30, leaseMs: LEASE_MS, now: at(1_000) })),
          ),
        );

        const claimed = batches.flat();
        expect(new Set(claimed).size).toBe(claimed.length);
        expect(claimed.sort()).toEqual(pending.map((transaction) => transaction.id).sort());
      });

      it('skips a row locked by another unit of work instead of waiting for it', async () => {
        const wallet = await openWallet();
        const [locked, free] = [pendingOf(wallet, at(0)), pendingOf(wallet, at(1))];
        await uow.run(async (tx) => {
          await tx.wagers.insert(locked);
          await tx.wagers.insert(free);
        });
        const held = deferred();
        const release = deferred();
        const holder = uow.run(async (tx) => {
          await tx.wagers.lockById(locked.id);
          held.resolve();
          await release.promise;
        });
        await held.promise;

        const claimed = await within(
          uow.run((tx) => tx.wagers.claimPendingBatch({ limit: 10, leaseMs: LEASE_MS, now: at(100) })),
          1_000,
          'claiming past a locked row',
        );
        release.resolve();
        await holder;

        expect(claimed).toEqual([free.id]);
      });
    });
  });
};
