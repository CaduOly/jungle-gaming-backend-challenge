import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../../src/business/shared/error/failure-code';
import { Money } from '../../../src/business/shared/value-object/money';
import { reconcileWallet } from '../../../src/business/wallet/domain-service/wallet-reconciliation';
import { Wallet } from '../../../src/business/wallet/entity/wallet';
import { LedgerEntryType } from '../../../src/business/wallet/enum/ledger-entry-type';
import { WalletAlreadyExistsError } from '../../../src/business/wallet/error/wallet-already-exists-error';
import { InMemoryLedger, LedgerConstraintError } from './in-memory-ledger';
import { InMemoryWalletRepository, InMemoryWalletStore, StaleWalletVersionError } from './in-memory-wallet-repository';
import { KeyedMutex } from './keyed-mutex';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

const seed = async (initialBalance = '100.00') => {
  const store = new InMemoryWalletStore();
  const ledger = new InMemoryLedger();
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    openingTransactionId: 'opening',
    at,
  });
  await new InMemoryWalletRepository(store).insert(wallet);
  if (openingEntry) await ledger.append(openingEntry);
  return { store, ledger };
};

describe('KeyedMutex', () => {
  it('serializes holders of the same key in FIFO order and frees the key afterwards', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const run = async (name: string): Promise<void> => {
      const release = await mutex.acquire('k');
      order.push(`${name}:in`);
      await tick();
      order.push(`${name}:out`);
      release();
    };
    await Promise.all([run('a'), run('b'), run('c')]);
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
    expect(mutex.isLocked('k')).toBe(false);
  });

  it('does not block different keys', async () => {
    const mutex = new KeyedMutex();
    const releaseA = await mutex.acquire('a');
    const releaseB = await mutex.acquire('b');
    releaseA();
    releaseB();
  });

  it('ignores a second release', async () => {
    const mutex = new KeyedMutex();
    const release = await mutex.acquire('k');
    release();
    release();
    const again = await mutex.acquire('k');
    again();
    expect(mutex.isLocked('k')).toBe(false);
  });
});

describe('InMemoryWalletRepository', () => {
  it('returns copies: changes are invisible until update', async () => {
    const { store } = await seed();
    const repository = new InMemoryWalletRepository(store);
    const wallet = await repository.lockById('wallet-1');
    wallet?.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('1.00'), at });
    expect((await repository.findById('wallet-1'))?.balance).toEqual(brl('100.00'));
    await repository.releaseLocks();
  });

  it('returns null without locking for an unknown wallet', async () => {
    const { store } = await seed();
    const repository = new InMemoryWalletRepository(store);
    expect(await repository.lockById('missing')).toBeNull();
    expect(store.locks.isLocked('missing')).toBe(false);
  });

  it('enforces one wallet per player and currency', async () => {
    const { store } = await seed();
    const repository = new InMemoryWalletRepository(store);
    const { wallet } = Wallet.open({ id: 'wallet-2', playerId: 'player-1', initialBalance: Money.zero('BRL'), at });
    expect(await repository.existsByPlayerAndCurrency('player-1', 'BRL')).toBe(true);
    expect(await repository.existsByPlayerAndCurrency('player-1', 'USD')).toBe(false);
    await expect(repository.insert(wallet)).rejects.toThrow(WalletAlreadyExistsError);
    const usd = Wallet.open({ id: 'wallet-3', playerId: 'player-1', initialBalance: Money.zero('USD'), at });
    await repository.insert(usd.wallet);
  });

  it('requires the lock and the expected version to update', async () => {
    const { store } = await seed();
    const repository = new InMemoryWalletRepository(store);
    const unlocked = await repository.findById('wallet-1');
    await expect(repository.update(unlocked!, 1)).rejects.toThrow('must be locked');
    const wallet = (await repository.lockById('wallet-1'))!;
    wallet.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('1.00'), at });
    await expect(repository.update(wallet, 2)).rejects.toThrow(StaleWalletVersionError);
    await repository.update(wallet, 1);
    await repository.releaseLocks();
    expect(store.read('wallet-1')?.version).toBe(2);
    expect(store.locks.isLocked('wallet-1')).toBe(false);
  });

  it('is re-entrant for concurrent locks of the same wallet within one scope', async () => {
    const { store } = await seed();
    const repository = new InMemoryWalletRepository(store);
    const [first, second] = await Promise.all([repository.lockById('wallet-1'), repository.lockById('wallet-1')]);
    expect(first?.id).toBe('wallet-1');
    expect(second?.id).toBe('wallet-1');
    await repository.releaseLocks();
    expect(store.locks.isLocked('wallet-1')).toBe(false);
  });

  it('is re-entrant within the same scope', async () => {
    const { store } = await seed();
    const repository = new InMemoryWalletRepository(store);
    await repository.lockById('wallet-1');
    await repository.lockById('wallet-1');
    await repository.releaseLocks();
    expect(store.locks.isLocked('wallet-1')).toBe(false);
  });

  it('prevents lost updates: 50 concurrent debits of 2.00 over 100.00 leave exactly 0.00', async () => {
    const { store, ledger } = await seed('100.00');
    const outcomes = await Promise.all(
      Array.from({ length: 60 }, async (_, index) => {
        const repository = new InMemoryWalletRepository(store);
        try {
          const wallet = (await repository.lockById('wallet-1'))!;
          await tick();
          const expectedVersion = wallet.version;
          const entry = wallet.debit({
            transactionId: `bet-${index}`,
            entryType: LedgerEntryType.BET,
            amount: brl('2.00'),
            at,
            insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
          });
          await ledger.append(entry);
          await repository.update(wallet, expectedVersion);
          return 'processed';
        } catch {
          return 'rejected';
        } finally {
          await repository.releaseLocks();
        }
      }),
    );
    expect(outcomes.filter((outcome) => outcome === 'processed')).toHaveLength(50);
    const wallet = store.read('wallet-1')!;
    expect(wallet.balance).toEqual(brl('0.00'));
    expect(wallet.version).toBe(51);
    expect(reconcileWallet(wallet, await ledger.listAll('wallet-1')).consistent).toBe(true);
  });
});

describe('InMemoryLedger', () => {
  it('assigns ascending seqs and pages with an opaque cursor', async () => {
    const { store, ledger } = await seed('10.00');
    const repository = new InMemoryWalletRepository(store);
    const wallet = (await repository.lockById('wallet-1'))!;
    for (let index = 0; index < 4; index += 1) {
      await ledger.append(
        wallet.credit({ transactionId: `win-${index}`, entryType: LedgerEntryType.WIN, amount: brl('1.00'), at }),
      );
    }
    await repository.releaseLocks();

    const first = await ledger.page({ walletId: 'wallet-1', after: null, limit: 2 });
    expect(first.entries.map((entry) => entry.walletVersion)).toEqual([1, 2]);
    expect(first.next).not.toBeNull();
    const second = await ledger.page({ walletId: 'wallet-1', after: first.next, limit: 2 });
    expect(second.entries.map((entry) => entry.walletVersion)).toEqual([3, 4]);
    const third = await ledger.page({ walletId: 'wallet-1', after: second.next, limit: 2 });
    expect(third.entries.map((entry) => entry.walletVersion)).toEqual([5]);
    expect(third.next).toBeNull();
    expect((await ledger.listAll('wallet-1')).map((entry) => entry.seq)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(await ledger.page({ walletId: 'other', after: null, limit: 10 })).toEqual({ entries: [], next: null });
  });

  it('returns no next cursor when the last page is exactly full', async () => {
    const { store, ledger } = await seed('10.00');
    const wallet = store.read('wallet-1')!;
    await ledger.append(
      wallet.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('1.00'), at }),
    );
    const page = await ledger.page({ walletId: 'wallet-1', after: null, limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.next).toBeNull();
    const firstOfTwo = await ledger.page({ walletId: 'wallet-1', after: null, limit: 1 });
    expect(firstOfTwo.next?.seq).toBe(1n);
  });

  it('enforces UNIQUE(transaction_id) and UNIQUE(wallet_id, wallet_version)', async () => {
    const { store, ledger } = await seed('10.00');
    const wallet = store.read('wallet-1')!;
    const twin = store.read('wallet-1')!;
    const entry = wallet.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('1.00'), at });
    await ledger.append(entry);
    await expect(ledger.append(entry)).rejects.toThrow(LedgerConstraintError);
    const sameVersion = twin.credit({ transactionId: 'win-2', entryType: LedgerEntryType.WIN, amount: brl('1.00'), at });
    await expect(ledger.append(sameVersion)).rejects.toThrow('UNIQUE(wallet_id, wallet_version)');
    expect(ledger.count()).toBe(2);
  });
});
