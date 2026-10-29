import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../src/business/messaging/entity/inbox-message';
import { OutboxMessage } from '../../../src/business/messaging/entity/outbox-message';
import { FailureCode } from '../../../src/business/shared/error/failure-code';
import { Money } from '../../../src/business/shared/value-object/money';
import { Wallet } from '../../../src/business/wallet/entity/wallet';
import { LedgerEntryType } from '../../../src/business/wallet/enum/ledger-entry-type';
import { WagerKind } from '../../../src/business/wagering/enum/wager-kind';
import { aProcessedWager } from '../builders/wager-transaction.builder';
import { assertFakeWalletConsistency, findFakeWalletInconsistencies } from '../assertions/assert-fake-wallet-consistency';
import { aFakeEvent } from './fake-integration-event';
import { FakeDatabase, FakeUnitOfWork, InjectedFaultError, ReadOnlyTransactionError } from './fake-unit-of-work';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

const seeded = async (): Promise<FakeUnitOfWork> => {
  const uow = new FakeUnitOfWork();
  await uow.run(async (tx) => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openingTransactionId: 'opening',
      at,
    });
    await tx.wallets.insert(wallet);
    await tx.ledger.append(openingEntry!);
  });
  return uow;
};

const betInside = async (uow: FakeUnitOfWork, id: string, amount = '10.00'): Promise<void> =>
  uow.run(async (tx) => {
    const wallet = (await tx.wallets.lockById('wallet-1'))!;
    const expected = wallet.version;
    const entry = wallet.debit({
      transactionId: id,
      entryType: LedgerEntryType.BET,
      amount: brl(amount),
      at,
      insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    await tx.wagers.insert(aProcessedWager(WagerKind.BET, id, { id }));
    await tx.ledger.append(entry);
    await tx.wallets.update(wallet, expected);
    await tx.outbox.add([OutboxMessage.fromEvent(aFakeEvent({ eventId: `evt-${id}` }))]);
    await tx.inbox.insertIfAbsent(
      InboxMessage.create({ consumerName: 'c', messageId: `msg-${id}`, payloadHash: 'h', receivedAt: at }),
    );
  });

describe('FakeUnitOfWork', () => {
  it('commits every repository together', async () => {
    const uow = await seeded();
    await betInside(uow, 'bet-1');
    const { db } = uow;
    expect(db.wallets.read('wallet-1')?.balance).toEqual(brl('90.00'));
    expect(db.ledger.count()).toBe(2);
    expect(db.wagers.all()).toHaveLength(1);
    expect(db.outbox.all()).toHaveLength(1);
    expect(db.inbox.size()).toBe(1);
    expect(uow.commits).toBe(2);
    await assertFakeWalletConsistency(db, 'wallet-1');
  });

  it('rolls back every write of a unit that throws, wherever it fails', async () => {
    for (const point of ['wagers.insert', 'ledger.append', 'wallets.update', 'outbox.add', 'inbox.insertIfAbsent'] as const) {
      const uow = await seeded();
      uow.failNext(point);
      await expect(betInside(uow, 'bet-1')).rejects.toThrow(InjectedFaultError);
      const { db } = uow;
      expect(db.wallets.read('wallet-1')?.balance).toEqual(brl('100.00'));
      expect(db.wallets.read('wallet-1')?.version).toBe(1);
      expect(db.ledger.count()).toBe(1);
      expect(db.wagers.all()).toEqual([]);
      expect(db.outbox.all()).toEqual([]);
      expect(db.inbox.size()).toBe(0);
      expect(db.wallets.locks.isLocked('wallet-1')).toBe(false);
      expect(uow.rollbacks).toBe(1);
      await assertFakeWalletConsistency(db, 'wallet-1');
    }
  });

  it('a rollback keeps what other units committed meanwhile', async () => {
    const uow = await seeded();
    const db = uow.db;
    const other = new FakeUnitOfWork(db);
    uow.before('outbox.add', async () => {
      await tick();
      await other.run(async (tx) => {
        await tx.inbox.insertIfAbsent(
          InboxMessage.create({ consumerName: 'c', messageId: 'other', payloadHash: 'h', receivedAt: at }),
        );
        await tx.wagers.insert(aProcessedWager(WagerKind.BET, 'other', { id: 'other' }));
      });
      throw new Error('boom');
    });
    await expect(betInside(uow, 'bet-1')).rejects.toThrow('boom');
    expect(db.wagers.all().map((transaction) => transaction.id)).toEqual(['other']);
    expect(await db.inbox.find('c', 'other')).toBeDefined();
    expect(db.wallets.read('wallet-1')?.balance).toEqual(brl('100.00'));
  });

  it('releases the locks after a commit and after a rollback', async () => {
    const uow = await seeded();
    await uow.run(async (tx) => {
      await tx.wallets.lockById('wallet-1');
      expect(uow.db.wallets.locks.isLocked('wallet-1')).toBe(true);
    });
    expect(uow.db.wallets.locks.isLocked('wallet-1')).toBe(false);
    await expect(
      uow.run(async (tx) => {
        await tx.wallets.lockById('wallet-1');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(uow.db.wallets.locks.isLocked('wallet-1')).toBe(false);
  });

  it('serializes units on the wallet lock: 12 parallel debits of 10.00 over 100.00', async () => {
    const uow = await seeded();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => betInside(uow, `bet-${i}`)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    expect(uow.db.wallets.read('wallet-1')?.balance).toEqual(brl('0.00'));
    expect(uow.db.wagers.all()).toHaveLength(10);
    expect(uow.db.outbox.all()).toHaveLength(10);
    await assertFakeWalletConsistency(uow.db, 'wallet-1');
  });

  it('runs each hook only the requested number of times', async () => {
    const uow = await seeded();
    let calls = 0;
    uow.before('wagers.insert', () => void (calls += 1), 2);
    for (const id of ['a', 'b', 'c']) await betInside(uow, id);
    expect(calls).toBe(2);
    uow.failNext('ledger.append');
    uow.clearFaults();
    await betInside(uow, 'd');
  });

  it('refuses writes in a snapshot-read unit', async () => {
    const uow = await seeded();
    await expect(
      uow.run(async (tx) => tx.outbox.add([]), { mode: 'snapshot-read' }),
    ).rejects.toThrow(ReadOnlyTransactionError);
    expect(await uow.run(async (tx) => (await tx.wallets.findById('wallet-1'))?.version, { mode: 'snapshot-read' })).toBe(1);
  });
});

describe('assertFakeWalletConsistency', () => {
  it('flags a balance that the ledger does not explain', async () => {
    const db = new FakeDatabase();
    const { wallet } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('5.00'), openingTransactionId: 'o', at });
    db.wallets.write(wallet);
    expect(await findFakeWalletInconsistencies(db, 'w')).toContain(
      'balance 5.00 differs from ledger sum (credits 0.00, debits 0.00)',
    );
    expect(await findFakeWalletInconsistencies(db, 'missing')).toEqual(['wallet missing not found']);
  });
});
