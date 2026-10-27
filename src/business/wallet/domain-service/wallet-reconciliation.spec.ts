import { describe, expect, it } from 'bun:test';
import { FailureCode } from '../../shared/error/failure-code';
import { Money } from '../../shared/value-object/money';
import { Wallet } from '../entity/wallet';
import { type LedgerEntryState, WalletLedgerEntry } from '../entity/wallet-ledger-entry';
import { LedgerDirection } from '../enum/ledger-direction';
import { LedgerEntryType } from '../enum/ledger-entry-type';
import { type DivergenceCode, reconcileWallet } from './wallet-reconciliation';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const history = (initialBalance = '100.00') => {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialBalance),
    openingTransactionId: 'opening',
    at,
  });
  const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
  entries.push(
    wallet.credit({ transactionId: 'win', entryType: LedgerEntryType.WIN, amount: brl('50.00'), at }),
    wallet.debit({
      transactionId: 'bet',
      entryType: LedgerEntryType.BET,
      amount: brl('30.25'),
      at,
      insufficientFundsCode: FailureCode.INSUFFICIENT_FUNDS,
    }),
  );
  return { wallet, entries: entries.map((entry, index) => entry.withSeq(BigInt(index + 1))) };
};

const tamper = (entry: WalletLedgerEntry, changes: Partial<LedgerEntryState>): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({ ...entry.toState(), ...changes });

const rehydrateWallet = (wallet: Wallet, changes: { balance?: Money; version?: number }): Wallet =>
  Wallet.rehydrate({ ...wallet.toState(), ...changes });

const codes = (wallet: Wallet, entries: WalletLedgerEntry[]): DivergenceCode[] =>
  reconcileWallet(wallet, entries).divergences.map((divergence) => divergence.code);

describe('reconcileWallet', () => {
  it('reports a consistent wallet opened with balance (first version 1)', () => {
    const { wallet, entries } = history('100.00');
    const result = reconcileWallet(wallet, entries);
    expect(result).toEqual({
      walletId: 'wallet-1',
      storedBalance: brl('119.75'),
      calculatedBalance: brl('119.75'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 3,
      divergences: [],
    });
  });

  it('reports a consistent wallet opened at zero (first version 2)', () => {
    const { wallet, entries } = history('0.00');
    expect(entries[0]?.walletVersion).toBe(2);
    expect(reconcileWallet(wallet, entries).consistent).toBe(true);
  });

  it('accepts a fresh wallet without entries at version 1 and zero balance', () => {
    const { wallet } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at });
    const result = reconcileWallet(wallet, []);
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
    expect(result.calculatedBalance).toEqual(Money.zero('BRL'));
  });

  it('flags a stored balance that differs from the ledger, with the absolute difference', () => {
    const { wallet, entries } = history();
    const drifted = rehydrateWallet(wallet, { balance: brl('100.00') });
    const result = reconcileWallet(drifted, entries);
    expect(result.consistent).toBe(false);
    expect(result.calculatedBalance).toEqual(brl('119.75'));
    expect(result.difference).toEqual(brl('19.75'));
    expect(result.divergences.map((d) => d.code)).toEqual(['LAST_BALANCE_MISMATCH', 'BALANCE_MISMATCH']);
  });

  it('flags a missing entry (version gap and chain break)', () => {
    const { wallet, entries } = history();
    const [opening, , bet] = entries;
    expect(codes(wallet, [opening!, bet!])).toEqual(['CHAIN_BROKEN', 'VERSION_GAP', 'BALANCE_MISMATCH']);
  });

  it('flags broken entry arithmetic', () => {
    const { wallet, entries } = history();
    const broken = tamper(entries[1]!, { balanceAfter: brl('150.01') });
    expect(codes(wallet, [entries[0]!, broken, entries[2]!])).toContain('ARITHMETIC_BROKEN');
  });

  it('flags a first entry that does not start from zero', () => {
    const { wallet, entries } = history();
    const first = tamper(entries[0]!, { balanceBefore: brl('1.00'), balanceAfter: brl('101.00') });
    expect(codes(wallet, [first, ...entries.slice(1)])).toContain('FIRST_BALANCE_NOT_ZERO');
  });

  it.each([0, 3])('flags a first walletVersion of %p', (walletVersion) => {
    const { wallet, entries } = history();
    const first = tamper(entries[0]!, { walletVersion });
    expect(codes(wallet, [first, ...entries.slice(1)])).toContain('FIRST_VERSION_INVALID');
  });

  it('flags a last walletVersion that differs from wallet.version', () => {
    const { wallet, entries } = history();
    expect(codes(rehydrateWallet(wallet, { version: 9 }), entries)).toEqual(['LAST_VERSION_MISMATCH']);
  });

  it('flags a version above 1 with no entries', () => {
    const { wallet } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at });
    expect(codes(rehydrateWallet(wallet, { version: 2 }), [])).toEqual(['VERSION_WITHOUT_ENTRIES']);
  });

  it('flags a repeated seq', () => {
    const { wallet, entries } = history();
    const repeated = [entries[0]!, entries[1]!.withSeq(2n), entries[2]!.withSeq(2n)];
    expect(codes(wallet, repeated)).toEqual(['SEQ_NOT_ASCENDING']);
  });

  it('flags an OPENING that is not the first entry', () => {
    const { wallet, entries } = history();
    const moved = tamper(entries[2]!, { entryType: LedgerEntryType.OPENING });
    expect(codes(wallet, [entries[0]!, entries[1]!, moved])).toEqual(['OPENING_MISPLACED']);
  });

  it('flags a first entry at version 1 that is not OPENING', () => {
    const { wallet, entries } = history();
    const notOpening = tamper(entries[0]!, { entryType: LedgerEntryType.WIN });
    expect(codes(wallet, [notOpening, ...entries.slice(1)])).toEqual(['OPENING_MISPLACED']);
  });

  it('flags an OPENING first entry at version 2', () => {
    const { wallet, entries } = history('0.00');
    const opening = tamper(entries[0]!, { entryType: LedgerEntryType.OPENING });
    expect(codes(wallet, [opening, ...entries.slice(1)])).toEqual(['OPENING_MISPLACED']);
  });

  it('flags a non-positive amount', () => {
    const { wallet, entries } = history();
    const zero = tamper(entries[1]!, { amount: brl('0.00'), balanceAfter: entries[1]!.balanceBefore });
    expect(codes(wallet, [entries[0]!, zero, entries[2]!])).toContain('AMOUNT_NOT_POSITIVE');
  });

  it('flags an unknown direction and leaves it out of the sum', () => {
    const { wallet, entries } = history();
    const unknown = tamper(entries[1]!, { direction: 'SIDEWAYS' as LedgerEntryState['direction'] });
    const result = reconcileWallet(wallet, [entries[0]!, unknown, entries[2]!]);
    expect(result.divergences.map((d) => d.code)).toContain('UNKNOWN_DIRECTION');
    expect(result.calculatedBalance).toEqual(brl('69.75'));
  });

  it('flags entries out of seq order', () => {
    const { wallet, entries } = history();
    const reordered = [entries[0]!, entries[1]!.withSeq(5n), entries[2]!.withSeq(4n)];
    expect(codes(wallet, reordered)).toEqual(['SEQ_NOT_ASCENDING']);
  });

  it('flags and skips entries from another wallet or currency', () => {
    const { wallet, entries } = history();
    const foreignWallet = tamper(entries[1]!, { walletId: 'wallet-2' });
    const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
    const foreignCurrency = tamper(entries[1]!, {
      amount: usd('50.00'),
      balanceBefore: usd('100.00'),
      balanceAfter: usd('150.00'),
    });
    const result = reconcileWallet(wallet, [...entries, foreignWallet, foreignCurrency]);
    expect(result.divergences.map((d) => d.code)).toEqual(['FOREIGN_ENTRY', 'FOREIGN_ENTRY']);
    expect(result.calculatedBalance).toEqual(brl('119.75'));
    expect(result.checkedEntries).toBe(5);
  });

  it('reports a ledger that would go negative without throwing', () => {
    const { wallet } = Wallet.open({ id: 'wallet-1', playerId: 'p', initialBalance: Money.zero('BRL'), at });
    const overdraft = WalletLedgerEntry.rehydrate({
      walletId: 'wallet-1',
      transactionId: 'bet',
      direction: LedgerDirection.DEBIT,
      entryType: LedgerEntryType.BET,
      amount: brl('5.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('0.00'),
      walletVersion: 1,
      createdAt: at,
      seq: 1n,
    });
    const result = reconcileWallet(wallet, [overdraft]);
    expect(result.consistent).toBe(false);
    expect(result.calculatedBalance).toBeNull();
    expect(result.difference).toBeNull();
    expect(result.divergences.map((d) => d.code)).toContain('LEDGER_SUM_OUT_OF_RANGE');
  });

  it('never mutates the wallet', () => {
    const { wallet, entries } = history();
    const before = wallet.toState();
    reconcileWallet(rehydrateWallet(wallet, { balance: brl('1.00') }), entries);
    expect(wallet.toState()).toEqual(before);
  });
});
