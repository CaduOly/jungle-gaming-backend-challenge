import { describe, expect, it } from 'bun:test';
import { aWager, brl, T0 } from '../../../../../tests/support/builders/wager-transaction.builder';
import { SequentialIdGenerator } from '../../../../../tests/support/fakes/sequential-id-generator';
import { FailureCode } from '../../../shared/error/failure-code';
import { InvalidTransactionStateError } from '../../../shared/error/invalid-transaction-state-error';
import { Wallet } from '../../../wallet/entity/wallet';
import { LedgerEntryType } from '../../../wallet/enum/ledger-entry-type';
import { WagerKind } from '../../enum/wager-kind';
import { WagerTransactionPendingReference } from '../../event/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../../event/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../event/wager-transaction-rejected.event';
import { WagerOutcomeEvents } from './wager-outcome-events';

const AT = new Date('2026-01-01T00:05:00.000Z');
const context = { correlationId: 'corr-1', causationId: 'msg-1', occurredAt: AT };

const walletWith = (balance: string): Wallet =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(balance),
    openingTransactionId: 'opening',
    at: T0,
  }).wallet;

describe('WagerOutcomeEvents', () => {
  const events = () => new WagerOutcomeEvents(new SequentialIdGenerator('evt'));

  it('PROCESSED with a movement → Processed and WalletBalanceChanged, both grouped by wallet', () => {
    const wallet = walletWith('100.00');
    const bet = aWager(WagerKind.BET, 'bet', { money: brl('25.00') });
    const entry = wallet.debit({
      transactionId: bet.id,
      entryType: LedgerEntryType.BET,
      amount: bet.money,
      at: AT,
      insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    bet.markProcessed(wallet.balance, AT);

    const [processed, balanceChanged, ...rest] = events().toEvents({ transaction: bet, wallet, entry }, context);

    expect(rest).toEqual([]);
    expect(processed).toBeInstanceOf(WagerTransactionProcessed);
    expect(processed?.toJSON()).toMatchObject({
      eventId: 'evt-0001',
      eventType: 'WagerTransactionProcessed',
      aggregateType: 'Wallet',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: AT.toISOString(),
      data: {
        transactionId: bet.id,
        kind: 'BET',
        status: 'PROCESSED',
        money: { amount: '25.00', currency: 'BRL' },
        balance: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
        failureCode: null,
        referenceTransactionId: null,
        processedAt: AT.toISOString(),
      },
    });
    expect(balanceChanged?.toJSON()).toMatchObject({
      eventId: 'evt-0002',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      data: { transactionId: bet.id, direction: 'DEBIT', walletVersion: 2 },
    });
  });

  it('LOSS is processed without a balance event', () => {
    const wallet = walletWith('100.00');
    const loss = aWager(WagerKind.LOSS, 'loss', { money: brl('0.00') });
    loss.markProcessed(wallet.balance, AT);
    const emitted = events().toEvents({ transaction: loss, wallet, entry: null }, context);
    expect(emitted.map((event) => event.eventType)).toEqual(['WagerTransactionProcessed']);
  });

  it('REJECTED → Rejected carrying the failure code and the observed balance', () => {
    const wallet = walletWith('10.00');
    const bet = aWager(WagerKind.BET, 'bet', { money: brl('25.00') });
    bet.reject(FailureCode.INSUFFICIENT_FUNDS, wallet.balance, AT);
    const [rejected] = events().toEvents({ transaction: bet, wallet, entry: null }, context);
    expect(rejected).toBeInstanceOf(WagerTransactionRejected);
    expect(rejected?.data).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
      rejectedAt: AT.toISOString(),
    });
  });

  it('PENDING_REFERENCE → PendingReference with the next attempt', () => {
    const wallet = walletWith('10.00');
    const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'bet' });
    rollback.markPendingReference(new Date(AT.getTime() + 2_000));
    const [pending] = events().toEvents({ transaction: rollback, wallet, entry: null }, context);
    expect(pending).toBeInstanceOf(WagerTransactionPendingReference);
    expect(pending?.data).toMatchObject({
      referenceExternalTransactionId: 'bet',
      attempts: 1,
      nextAttemptAt: '2026-01-01T00:05:02.000Z',
      balance: { amount: '10.00', currency: 'BRL' },
    });
  });

  it('FAILED has no integration event and PENDING is not a decision', () => {
    const wallet = walletWith('10.00');
    const failed = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'bet' });
    failed.markPendingReference(AT);
    failed.fail(FailureCode.WALLET_NOT_FOUND, AT);
    expect(events().toEvents({ transaction: failed, wallet, entry: null }, context)).toEqual([]);
    expect(() =>
      events().toEvents({ transaction: aWager(WagerKind.BET, 'bet'), wallet, entry: null }, context),
    ).toThrow(InvalidTransactionStateError);
  });

  it('each factory refuses a transaction in another status', () => {
    const wallet = walletWith('10.00');
    const bet = aWager(WagerKind.BET, 'bet');
    const ctx = { ...context, eventId: 'e' };
    expect(() => WagerTransactionProcessed.from(bet, wallet, ctx)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionRejected.from(bet, wallet, ctx)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionPendingReference.from(bet, wallet, ctx)).toThrow(InvalidTransactionStateError);
  });
});
