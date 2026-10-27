import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError } from '../../shared/error/currency-mismatch-error';
import { Money } from '../../shared/value-object/money';
import { LedgerDirection } from '../enum/ledger-direction';
import { LedgerEntryType } from '../enum/ledger-entry-type';
import { InvalidLedgerEntryError } from '../error/invalid-ledger-entry-error';
import { type CreateLedgerEntryProps, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const credit = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.CREDIT,
  entryType: LedgerEntryType.WIN,
  amount: brl('10.00'),
  balanceBefore: brl('5.00'),
  balanceAfter: brl('15.00'),
  walletVersion: 2,
  createdAt: at,
  ...overrides,
});

const debit = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps =>
  credit({
    direction: LedgerDirection.DEBIT,
    entryType: LedgerEntryType.BET,
    balanceBefore: brl('15.00'),
    balanceAfter: brl('5.00'),
    ...overrides,
  });

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    it('builds a balanced credit entry', () => {
      const entry = WalletLedgerEntry.create(credit());
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.direction).toBe('CREDIT');
      expect(entry.entryType).toBe('WIN');
      expect(entry.amount.toString()).toBe('10.00');
      expect(entry.balanceBefore.toString()).toBe('5.00');
      expect(entry.balanceAfter.toString()).toBe('15.00');
      expect(entry.walletVersion).toBe(2);
      expect(entry.currency).toBe('BRL');
      expect(entry.createdAt).toEqual(at);
      expect(entry.seq).toBeUndefined();
      expect(entry.isBalanced()).toBe(true);
    });

    it('builds a balanced debit entry, down to zero', () => {
      const entry = WalletLedgerEntry.create(debit({ balanceBefore: brl('10.00'), balanceAfter: brl('0.00') }));
      expect(entry.balanceAfter.isZero()).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    it.each([
      ['credit with after != before + amount', credit({ balanceAfter: brl('15.01') })],
      ['credit with after == before - amount', credit({ balanceBefore: brl('20.00'), balanceAfter: brl('10.00') })],
      ['debit with after != before - amount', debit({ balanceAfter: brl('5.01') })],
      ['debit with after == before + amount', debit({ balanceBefore: brl('5.00'), balanceAfter: brl('15.00') })],
    ])('rejects broken arithmetic: %s', (_name, props) => {
      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
    });

    it('rejects a zero amount', () => {
      expect(() =>
        WalletLedgerEntry.create(credit({ amount: brl('0.00'), balanceAfter: brl('5.00') })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects wallet version %p', (walletVersion) => {
      expect(() => WalletLedgerEntry.create(credit({ walletVersion }))).toThrow(InvalidLedgerEntryError);
    });

    it.each(['walletId', 'transactionId'] as const)('rejects an empty %s', (field) => {
      expect(() => WalletLedgerEntry.create(credit({ [field]: '' }))).toThrow(InvalidLedgerEntryError);
    });

    it.each([
      [LedgerEntryType.BET, LedgerDirection.CREDIT],
      [LedgerEntryType.WIN, LedgerDirection.DEBIT],
      [LedgerEntryType.REFUND, LedgerDirection.DEBIT],
      [LedgerEntryType.OPENING, LedgerDirection.DEBIT],
    ])('rejects %s as %s', (entryType, direction) => {
      const props = direction === LedgerDirection.CREDIT ? credit({ entryType }) : debit({ entryType });
      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
    });

    it('accepts ROLLBACK in both directions', () => {
      expect(WalletLedgerEntry.create(credit({ entryType: LedgerEntryType.ROLLBACK })).direction).toBe('CREDIT');
      expect(WalletLedgerEntry.create(debit({ entryType: LedgerEntryType.ROLLBACK })).direction).toBe('DEBIT');
    });

    it('rejects mixed currencies', () => {
      const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
      expect(() => WalletLedgerEntry.create(credit({ amount: usd('10.00') }))).toThrow(CurrencyMismatchError);
      expect(() => WalletLedgerEntry.create(credit({ balanceAfter: usd('15.00') }))).toThrow(CurrencyMismatchError);
    });
  });

  describe('rehydrate', () => {
    it('restores persisted state, including seq, without revalidating', () => {
      const entry = WalletLedgerEntry.rehydrate({ ...credit({ balanceAfter: brl('99.00') }), seq: 42n });
      expect(entry.seq).toBe(42n);
      expect(entry.balanceAfter.toString()).toBe('99.00');
      expect(entry.isBalanced()).toBe(false);
    });

    it('withSeq returns a copy carrying the persisted sequence', () => {
      const entry = WalletLedgerEntry.create(credit());
      const persisted = entry.withSeq(7n);
      expect(persisted.seq).toBe(7n);
      expect(entry.seq).toBeUndefined();
      expect(persisted.toState()).toEqual({ ...entry.toState(), seq: 7n });
    });
  });

  it('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create(credit());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as Record<string, unknown>).walletVersion = 3;
    }).toThrow(TypeError);
    expect(entry.walletVersion).toBe(2);
  });
});
