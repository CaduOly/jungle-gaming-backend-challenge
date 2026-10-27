import { describe, expect, it } from 'bun:test';
import { aProcessedWager, aWager, brl, T0, usd } from '../../../../tests/support/builders/wager-transaction.builder';
import { Money } from '../../shared/value-object/money';
import { Wallet } from '../../wallet/entity/wallet';
import type { WagerTransaction } from '../entity/wager-transaction';
import { WagerKind } from '../enum/wager-kind';
import { InvalidWagerTransactionError } from '../error/invalid-wager-transaction-error';
import { WagerSettlement } from './wager-settlement';

const AT = new Date('2026-01-01T00:01:00.000Z');
const settlement = new WagerSettlement();

const walletWith = (balance: string): Wallet =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(balance),
    openingTransactionId: 'opening',
    at: T0,
  }).wallet;

const settle = (transaction: WagerTransaction, wallet: Wallet, reference: WagerTransaction | null = null) =>
  settlement.settle({ transaction, wallet, reference, at: AT });

describe('WagerSettlement', () => {
  it('BET debits the wallet and processes the transaction', () => {
    const wallet = walletWith('100.00');
    const bet = aWager(WagerKind.BET, 'bet', { money: brl('25.00') });
    const outcome = settle(bet, wallet);
    expect(outcome.type).toBe('Processed');
    if (outcome.type === 'Processed') {
      expect(outcome.entry?.direction).toBe('DEBIT');
      expect(outcome.entry?.entryType).toBe('BET');
      expect(outcome.entry?.transactionId).toBe(bet.id);
      expect(outcome.entry?.walletVersion).toBe(2);
    }
    expect(wallet.balance).toEqual(brl('75.00'));
    expect(bet.status).toBe('PROCESSED');
    expect(bet.observedBalance).toEqual(brl('75.00'));
    expect(bet.processedAt).toEqual(AT);
  });

  it('BET without funds is rejected with INSUFFICIENT_FUNDS and the wallet is untouched', () => {
    const wallet = walletWith('10.00');
    const bet = aWager(WagerKind.BET, 'bet', { money: brl('10.01') });
    expect(settle(bet, wallet)).toEqual({ type: 'Rejected', code: 'INSUFFICIENT_FUNDS' });
    expect(bet.status).toBe('REJECTED');
    expect(bet.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(bet.observedBalance).toEqual(brl('10.00'));
    expect(wallet.balance).toEqual(brl('10.00'));
    expect(wallet.version).toBe(1);
  });

  it('WIN credits the wallet, with or without a reference', () => {
    const wallet = walletWith('10.00');
    const bet = aProcessedWager(WagerKind.BET, 'bet');
    const win = aWager(WagerKind.WIN, 'win', { money: brl('40.00'), referenceExternalTransactionId: 'bet' });
    const outcome = settle(win, wallet, bet);
    expect(outcome.type === 'Processed' && outcome.entry?.direction).toBe('CREDIT');
    expect(win.referenceTransactionId).toBe(bet.id);
    settle(aWager(WagerKind.WIN, 'win-2', { money: brl('1.00') }), wallet);
    expect(wallet.balance).toEqual(brl('51.00'));
  });

  it.each(['0.00', '5.00'])('LOSS of %p processes without touching the wallet', (amount) => {
    const wallet = walletWith('10.00');
    const loss = aWager(WagerKind.LOSS, 'loss', { money: brl(amount) });
    expect(settle(loss, wallet)).toEqual({ type: 'Processed', entry: null });
    expect(loss.status).toBe('PROCESSED');
    expect(loss.observedBalance).toEqual(brl('10.00'));
    expect(wallet.version).toBe(1);
  });

  it('REFUND credits the bet back', () => {
    const wallet = walletWith('90.00');
    const bet = aProcessedWager(WagerKind.BET, 'bet');
    const refund = aWager(WagerKind.REFUND, 'refund', { referenceExternalTransactionId: 'bet' });
    const outcome = settle(refund, wallet, bet);
    expect(outcome.type === 'Processed' && outcome.entry?.entryType).toBe('REFUND');
    expect(wallet.balance).toEqual(brl('100.00'));
  });

  it.each([
    [WagerKind.BET, 'CREDIT', '110.00'],
    [WagerKind.WIN, 'DEBIT', '90.00'],
    [WagerKind.REFUND, 'DEBIT', '90.00'],
  ] as const)('ROLLBACK of a %s moves as %s', (referenceKind, direction, balance) => {
    const wallet = walletWith('100.00');
    const reference = aProcessedWager(
      referenceKind,
      'ref',
      referenceKind === 'REFUND' ? { referenceExternalTransactionId: 'bet' } : {},
    );
    const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'ref' });
    const outcome = settle(rollback, wallet, reference);
    expect(outcome.type === 'Processed' && outcome.entry?.direction).toBe(direction);
    expect(outcome.type === 'Processed' && outcome.entry?.entryType).toBe('ROLLBACK');
    expect(wallet.balance).toEqual(brl(balance));
  });

  it('a reversal that would overdraw is rejected with REVERSAL_INSUFFICIENT_FUNDS', () => {
    const wallet = walletWith('5.00');
    const win = aProcessedWager(WagerKind.WIN, 'win');
    const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'win' });
    expect(settle(rollback, wallet, win)).toEqual({ type: 'Rejected', code: 'REVERSAL_INSUFFICIENT_FUNDS' });
    expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(rollback.observedBalance).toEqual(brl('5.00'));
    expect(rollback.referenceTransactionId).toBe(win.id);
    expect(wallet.balance).toEqual(brl('5.00'));
  });

  it.each([WagerKind.BET, WagerKind.WIN, WagerKind.LOSS] as const)(
    '%s in another currency is rejected with CURRENCY_MISMATCH',
    (kind) => {
      const wallet = walletWith('100.00');
      const transaction = aWager(kind, 'tx', { money: usd('1.00') });
      expect(settle(transaction, wallet)).toEqual({ type: 'Rejected', code: 'CURRENCY_MISMATCH' });
      expect(transaction.observedBalance).toEqual(brl('100.00'));
      expect(wallet.version).toBe(1);
    },
  );

  it('a transaction for another player is rejected with WALLET_PLAYER_MISMATCH', () => {
    const wallet = walletWith('100.00');
    const bet = aWager(WagerKind.BET, 'bet', { playerId: 'player-2' });
    expect(settle(bet, wallet)).toEqual({ type: 'Rejected', code: 'WALLET_PLAYER_MISMATCH' });
    expect(wallet.balance).toEqual(brl('100.00'));
  });

  it('settles a PENDING_REFERENCE transaction once its reference shows up', () => {
    const wallet = walletWith('90.00');
    const refund = aWager(WagerKind.REFUND, 'refund', { referenceExternalTransactionId: 'bet' });
    refund.markPendingReference(T0);
    const outcome = settle(refund, wallet, aProcessedWager(WagerKind.BET, 'bet'));
    expect(outcome.type).toBe('Processed');
    expect(refund.status).toBe('PROCESSED');
    expect(refund.nextAttemptAt).toBeUndefined();
  });

  it('refuses programming errors instead of rejecting', () => {
    expect(() => settle(aWager(WagerKind.OPENING, 'open'), walletWith('1.00'))).toThrow(InvalidWagerTransactionError);
    expect(() => settle(aWager(WagerKind.BET, 'bet', { walletId: 'wallet-2' }), walletWith('1.00'))).toThrow(
      InvalidWagerTransactionError,
    );
    const rollback = aWager(WagerKind.ROLLBACK, 'rb', { referenceExternalTransactionId: 'ref' });
    expect(() => settle(rollback, walletWith('1.00'))).toThrow(InvalidWagerTransactionError);
  });

  it('never moves zero-balance wallets below zero', () => {
    const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: Money.zero('BRL'), at: T0 }).wallet;
    expect(settle(aWager(WagerKind.BET, 'bet', { money: brl('0.01') }), wallet)).toEqual({
      type: 'Rejected',
      code: 'INSUFFICIENT_FUNDS',
    });
  });
});
