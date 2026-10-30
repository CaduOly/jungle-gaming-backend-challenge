import { describe, expect, it } from 'bun:test';
import { BusinessRuleError } from '../../shared/error/business-rule-error';
import { CurrencyMismatchError } from '../../shared/error/currency-mismatch-error';
import { FailureCode } from '../../shared/error/failure-code';
import { MoneyOverflowError } from '../../shared/error/money-overflow-error';
import { Money } from '../../shared/value-object/money';
import { LedgerEntryType } from '../enum/ledger-entry-type';
import { InsufficientFundsError } from '../error/insufficient-funds-error';
import { InvalidLedgerEntryError } from '../error/invalid-ledger-entry-error';
import { WalletPlayerMismatchError } from '../error/wallet-player-mismatch-error';
import { Wallet } from './wallet';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const openedAt = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');

const open = (initialBalance = '100.00') =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    openingTransactionId: 'opening-tx',
    at: openedAt,
  });

const failureOf = (fn: () => unknown): BusinessRuleError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof BusinessRuleError) return error;
    throw error;
  }
  throw new Error('expected a BusinessRuleError');
};

describe('Wallet', () => {
  describe('open', () => {
    it('opens with a positive balance at version 1 and returns the OPENING entry', () => {
      const { wallet, openingEntry } = open('100.00');
      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(openedAt);
      expect(wallet.updatedAt).toEqual(openedAt);

      expect(openingEntry).not.toBeNull();
      expect(openingEntry?.entryType).toBe('OPENING');
      expect(openingEntry?.direction).toBe('CREDIT');
      expect(openingEntry?.transactionId).toBe('opening-tx');
      expect(openingEntry?.walletId).toBe('wallet-1');
      expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
      expect(openingEntry?.balanceAfter.toString()).toBe('100.00');
      expect(openingEntry?.amount.toString()).toBe('100.00');
      expect(openingEntry?.walletVersion).toBe(1);
      expect(openingEntry?.createdAt).toEqual(openedAt);
    });

    it('opens with zero balance at version 1 and no entry', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.zero('USD'),
        at: openedAt,
      });
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.currency).toBe('USD');
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeNull();
    });

    it('requires the opening transaction id when the initial balance is positive', () => {
      expect(() =>
        Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('1.00'), at: openedAt }),
      ).toThrow(InvalidLedgerEntryError);
    });
  });

  describe('credit', () => {
    it.each([LedgerEntryType.WIN, LedgerEntryType.REFUND, LedgerEntryType.ROLLBACK])(
      'applies a %s credit, bumps the version and returns the entry',
      (entryType) => {
        const { wallet } = open('100.00');
        const entry = wallet.credit({ transactionId: 'tx-2', entryType, amount: brl('25.50'), at: later });
        expect(wallet.balance.toString()).toBe('125.50');
        expect(wallet.version).toBe(2);
        expect(wallet.updatedAt).toEqual(later);
        expect(entry.direction).toBe('CREDIT');
        expect(entry.entryType).toBe(entryType);
        expect(entry.transactionId).toBe('tx-2');
        expect(entry.balanceBefore.toString()).toBe('100.00');
        expect(entry.balanceAfter.toString()).toBe('125.50');
        expect(entry.walletVersion).toBe(2);
        expect(entry.createdAt).toEqual(later);
      },
    );

    it('rejects a zero amount without changing state', () => {
      const { wallet } = open('100.00');
      expect(() =>
        wallet.credit({ transactionId: 'tx-2', entryType: LedgerEntryType.WIN, amount: brl('0.00'), at: later }),
      ).toThrow(InvalidLedgerEntryError);
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    it('rejects a different currency without changing state', () => {
      const { wallet } = open('100.00');
      expect(() =>
        wallet.credit({ transactionId: 'tx-2', entryType: LedgerEntryType.WIN, amount: usd('1.00'), at: later }),
      ).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
    });

    it('rejects a credit that overflows without changing state', () => {
      const { wallet } = open('999999999999999999.99');
      expect(() =>
        wallet.credit({ transactionId: 'tx-2', entryType: LedgerEntryType.WIN, amount: brl('0.01'), at: later }),
      ).toThrow(MoneyOverflowError);
      expect(wallet.version).toBe(1);
    });
  });

  describe('debit', () => {
    it('applies a BET debit, bumps the version and returns the entry', () => {
      const { wallet } = open('100.00');
      const entry = wallet.debit({
        transactionId: 'tx-2',
        entryType: LedgerEntryType.BET,
        amount: brl('25.00'),
        at: later,
        insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
      });
      expect(wallet.balance.toString()).toBe('75.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe('DEBIT');
      expect(entry.entryType).toBe('BET');
      expect(entry.balanceBefore.toString()).toBe('100.00');
      expect(entry.balanceAfter.toString()).toBe('75.00');
      expect(entry.walletVersion).toBe(2);
    });

    it('allows debiting the whole balance', () => {
      const { wallet } = open('10.00');
      wallet.debit({
        transactionId: 'tx-2',
        entryType: LedgerEntryType.BET,
        amount: brl('10.00'),
        at: later,
        insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
      });
      expect(wallet.balance.isZero()).toBe(true);
    });

    it.each([FailureCode.INSUFFICIENT_FUNDS, FailureCode.REVERSAL_INSUFFICIENT_FUNDS] as const)(
      'rejects an overdraft with the caller-chosen %s, without changing state',
      (code) => {
        const { wallet } = open('10.00');
        const error = failureOf(() =>
          wallet.debit({
            transactionId: 'tx-2',
            entryType: code === FailureCode.INSUFFICIENT_FUNDS ? LedgerEntryType.BET : LedgerEntryType.ROLLBACK,
            amount: brl('10.01'),
            at: later,
            insufficientFundsCode: code,
          }),
        );
        expect(error).toBeInstanceOf(InsufficientFundsError);
        expect(error.failureCode).toBe(code);
        expect(wallet.balance.toString()).toBe('10.00');
        expect(wallet.version).toBe(1);
        expect(wallet.updatedAt).toEqual(openedAt);
      },
    );

    it('rejects a zero amount', () => {
      const { wallet } = open('10.00');
      expect(() =>
        wallet.debit({
          transactionId: 'tx-2',
          entryType: LedgerEntryType.BET,
          amount: brl('0.00'),
          at: later,
          insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
        }),
      ).toThrow(InvalidLedgerEntryError);
      expect(wallet.version).toBe(1);
    });

    it('rejects a different currency before checking funds', () => {
      const { wallet } = open('10.00');
      expect(() =>
        wallet.debit({
          transactionId: 'tx-2',
          entryType: LedgerEntryType.BET,
          amount: usd('100.00'),
          at: later,
          insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
        }),
      ).toThrow(CurrencyMismatchError);
    });
  });

  it('chains versions and balances across movements', () => {
    const { wallet, openingEntry } = open('100.00');
    const bet = wallet.debit({
      transactionId: 'bet',
      entryType: LedgerEntryType.BET,
      amount: brl('30.00'),
      at: later,
      insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    const win = wallet.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('45.25'), at: later });
    const rollback = wallet.debit({
      transactionId: 'rollback',
      entryType: LedgerEntryType.ROLLBACK,
      amount: brl('45.25'),
      at: later,
      insufficientFundsCode: FailureCode.REVERSAL_INSUFFICIENT_FUNDS,
    });
    const entries = [openingEntry, bet, win, rollback];
    expect(entries.map((entry) => entry?.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(bet.balanceBefore.equals(openingEntry?.balanceAfter ?? Money.zero('BRL'))).toBe(true);
    expect(win.balanceBefore.equals(bet.balanceAfter)).toBe(true);
    expect(rollback.balanceBefore.equals(win.balanceAfter)).toBe(true);
    expect(wallet.balance.equals(rollback.balanceAfter)).toBe(true);
    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(4);
  });

  it('rejects OPENING through credit or debit at runtime', () => {
    const { wallet } = open('10.00');
    const opening = LedgerEntryType.OPENING as typeof LedgerEntryType.WIN;
    expect(() => wallet.credit({ transactionId: 'tx', entryType: opening, amount: brl('1.00'), at: later })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      wallet.debit({
        transactionId: 'tx',
        entryType: opening as typeof LedgerEntryType.BET,
        amount: brl('1.00'),
        at: later,
        insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('10.00');
  });

  describe('ownership', () => {
    it('accepts the owner', () => {
      const { wallet } = open();
      expect(wallet.isOwnedBy('player-1')).toBe(true);
      expect(() => wallet.assertOwnedBy('player-1')).not.toThrow();
    });

    it('rejects another player with WALLET_PLAYER_MISMATCH', () => {
      const { wallet } = open();
      expect(wallet.isOwnedBy('player-2')).toBe(false);
      const error = failureOf(() => wallet.assertOwnedBy('player-2'));
      expect(error).toBeInstanceOf(WalletPlayerMismatchError);
      expect(error.failureCode).toBe(FailureCode.WALLET_PLAYER_MISMATCH);
    });
  });

  describe('rehydrate', () => {
    it('restores persisted state as-is and keeps moving from there', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-9',
        playerId: 'player-9',
        balance: brl('7.00'),
        version: 12,
        createdAt: openedAt,
        updatedAt: later,
      });
      expect(wallet.version).toBe(12);
      expect(wallet.currency).toBe('BRL');
      const entry = wallet.credit({ transactionId: 'tx', entryType: LedgerEntryType.WIN, amount: brl('1.00'), at: later });
      expect(entry.walletVersion).toBe(13);
      expect(wallet.toState()).toEqual({
        id: 'wallet-9',
        playerId: 'player-9',
        balance: brl('8.00'),
        version: 13,
        createdAt: openedAt,
        updatedAt: later,
      });
    });
  });

  it('copies the dates it receives, so the caller cannot rewrite its history', () => {
    const at = new Date(openedAt);
    const { wallet } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), openingTransactionId: 'o', at });
    at.setFullYear(2000);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);

    const creditAt = new Date(later);
    wallet.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('1.00'), at: creditAt });
    creditAt.setFullYear(2000);
    expect(wallet.updatedAt).toEqual(later);
    expect(wallet.createdAt).toEqual(openedAt);

    const debitAt = new Date('2026-01-03T00:00:00.000Z');
    wallet.debit({
      transactionId: 'bet',
      entryType: LedgerEntryType.BET,
      amount: brl('1.00'),
      at: debitAt,
      insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
    });
    debitAt.setFullYear(2000);
    expect(wallet.updatedAt).toEqual(new Date('2026-01-03T00:00:00.000Z'));
  });

  it('keeps createdAt and updatedAt independent after opening', () => {
    const { wallet } = open();
    wallet.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('1.00'), at: later });
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(later);
  });

  it('does not leak mutable dates', () => {
    const { wallet } = open();
    wallet.updatedAt.setFullYear(2000);
    wallet.createdAt.setFullYear(2000);
    expect(wallet.updatedAt).toEqual(openedAt);
    expect(wallet.createdAt).toEqual(openedAt);
  });
});
