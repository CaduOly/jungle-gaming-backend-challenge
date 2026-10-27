import { Money } from '../../shared/value-object/money';
import type { Wallet } from '../entity/wallet';
import type { WalletLedgerEntry } from '../entity/wallet-ledger-entry';

export const DivergenceCode = {
  BALANCE_MISMATCH: 'BALANCE_MISMATCH',
  LEDGER_SUM_OUT_OF_RANGE: 'LEDGER_SUM_OUT_OF_RANGE',
  FOREIGN_ENTRY: 'FOREIGN_ENTRY',
  ARITHMETIC_BROKEN: 'ARITHMETIC_BROKEN',
  FIRST_BALANCE_NOT_ZERO: 'FIRST_BALANCE_NOT_ZERO',
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  SEQ_NOT_ASCENDING: 'SEQ_NOT_ASCENDING',
  FIRST_VERSION_INVALID: 'FIRST_VERSION_INVALID',
  VERSION_GAP: 'VERSION_GAP',
  LAST_VERSION_MISMATCH: 'LAST_VERSION_MISMATCH',
  LAST_BALANCE_MISMATCH: 'LAST_BALANCE_MISMATCH',
  VERSION_WITHOUT_ENTRIES: 'VERSION_WITHOUT_ENTRIES',
} as const;

export type DivergenceCode = (typeof DivergenceCode)[keyof typeof DivergenceCode];

export interface Divergence {
  code: DivergenceCode;
  message: string;
}

export interface WalletReconciliation {
  walletId: string;
  storedBalance: Money;
  /** Null when the ledger cannot be summed into a valid amount (it would go negative or overflow). */
  calculatedBalance: Money | null;
  /** Absolute difference between stored and calculated balances; null when the latter is null. */
  difference: Money | null;
  consistent: boolean;
  checkedEntries: number;
  divergences: Divergence[];
}

const FIRST_VERSION_WITH_OPENING = 1;
const FIRST_VERSION_WITHOUT_OPENING = 2;

const describeEntry = (entry: WalletLedgerEntry, index: number): string =>
  `entry #${index} (seq ${entry.seq ?? 'unassigned'}, tx ${entry.transactionId})`;

const sumLedger = (currency: string, entries: readonly WalletLedgerEntry[]): Money | null => {
  let running = Money.zero(currency);
  for (const entry of entries) {
    if (entry.isCredit()) {
      try {
        running = running.add(entry.amount);
      } catch {
        return null;
      }
    } else {
      if (entry.amount.isGreaterThan(running)) return null;
      running = running.subtract(entry.amount);
    }
  }
  return running;
};

const absoluteDifference = (a: Money, b: Money): Money => (a.isGreaterThan(b) ? a.subtract(b) : b.subtract(a));

/**
 * Pure check of a wallet against its full ledger, ordered by seq. Mirrors the rules of
 * tests/support/assert-wallet-consistency.ts, with consecutive versions. Never corrects anything.
 */
export const reconcileWallet = (wallet: Wallet, entries: readonly WalletLedgerEntry[]): WalletReconciliation => {
  const divergences: Divergence[] = [];
  const report = (code: DivergenceCode, message: string): void => {
    divergences.push({ code, message });
  };

  const own: WalletLedgerEntry[] = [];
  entries.forEach((entry, index) => {
    if (entry.walletId !== wallet.id || entry.currency !== wallet.currency) {
      report(
        DivergenceCode.FOREIGN_ENTRY,
        `${describeEntry(entry, index)} belongs to wallet ${entry.walletId} in ${entry.currency}`,
      );
      return;
    }
    own.push(entry);
  });

  own.forEach((entry, index) => {
    const label = describeEntry(entry, index);
    if (!entry.isBalanced()) {
      report(
        DivergenceCode.ARITHMETIC_BROKEN,
        `${label}: ${entry.balanceBefore} ${entry.direction} ${entry.amount} <> ${entry.balanceAfter}`,
      );
    }
    const previous = own[index - 1];
    if (previous === undefined) {
      if (!entry.balanceBefore.isZero()) {
        report(DivergenceCode.FIRST_BALANCE_NOT_ZERO, `${label}: balanceBefore ${entry.balanceBefore} should be 0.00`);
      }
      if (entry.walletVersion !== FIRST_VERSION_WITH_OPENING && entry.walletVersion !== FIRST_VERSION_WITHOUT_OPENING) {
        report(DivergenceCode.FIRST_VERSION_INVALID, `${label}: first walletVersion ${entry.walletVersion} is not 1 or 2`);
      }
      return;
    }
    if (!entry.balanceBefore.equals(previous.balanceAfter)) {
      report(
        DivergenceCode.CHAIN_BROKEN,
        `${label}: balanceBefore ${entry.balanceBefore} does not chain from ${previous.balanceAfter}`,
      );
    }
    if (entry.walletVersion !== previous.walletVersion + 1) {
      report(
        DivergenceCode.VERSION_GAP,
        `${label}: walletVersion ${entry.walletVersion} does not follow ${previous.walletVersion}`,
      );
    }
    if (entry.seq !== undefined && previous.seq !== undefined && entry.seq <= previous.seq) {
      report(DivergenceCode.SEQ_NOT_ASCENDING, `${label}: seq does not increase after ${previous.seq}`);
    }
  });

  const last = own.at(-1);
  if (last === undefined) {
    if (wallet.version !== FIRST_VERSION_WITH_OPENING) {
      report(DivergenceCode.VERSION_WITHOUT_ENTRIES, `wallet.version ${wallet.version} with no ledger entries`);
    }
  } else {
    if (last.walletVersion !== wallet.version) {
      report(
        DivergenceCode.LAST_VERSION_MISMATCH,
        `last walletVersion ${last.walletVersion} differs from wallet.version ${wallet.version}`,
      );
    }
    if (!last.balanceAfter.equals(wallet.balance)) {
      report(
        DivergenceCode.LAST_BALANCE_MISMATCH,
        `last balanceAfter ${last.balanceAfter} differs from wallet.balance ${wallet.balance}`,
      );
    }
  }

  const calculatedBalance = sumLedger(wallet.currency, own);
  if (calculatedBalance === null) {
    report(DivergenceCode.LEDGER_SUM_OUT_OF_RANGE, 'ledger movements do not sum to a valid non-negative amount');
  } else if (!calculatedBalance.equals(wallet.balance)) {
    report(
      DivergenceCode.BALANCE_MISMATCH,
      `stored balance ${wallet.balance} differs from ledger sum ${calculatedBalance}`,
    );
  }

  return {
    walletId: wallet.id,
    storedBalance: wallet.balance,
    calculatedBalance,
    difference: calculatedBalance === null ? null : absoluteDifference(wallet.balance, calculatedBalance),
    consistent: divergences.length === 0,
    checkedEntries: entries.length,
    divergences,
  };
};
