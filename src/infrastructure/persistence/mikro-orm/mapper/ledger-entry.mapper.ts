import { WalletLedgerEntry } from '../../../../business/wallet/entity/wallet-ledger-entry';
import type { LedgerDirection } from '../../../../business/wallet/enum/ledger-direction';
import { LedgerEntryType } from '../../../../business/wallet/enum/ledger-entry-type';
import { toBigInt, toDate, toMoney, toText } from './sql-values';

export interface LedgerEntryRow {
  readonly seq: unknown;
  readonly wallet_id: string;
  readonly transaction_id: string;
  readonly direction: string;
  readonly amount: unknown;
  readonly currency: string;
  readonly balance_before: unknown;
  readonly balance_after: unknown;
  readonly wallet_version: number;
  readonly created_at: unknown;
  /** wager_transactions.kind: a tabela do ledger não tem coluna de tipo da entrada, o tipo é o kind da transação. */
  readonly kind: string;
}

/** Vem de `wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id`. */
export const LEDGER_SELECT = `
  SELECT l.seq, l.wallet_id, l.transaction_id, l.direction, l.amount, l.currency, l.balance_before,
         l.balance_after, l.wallet_version, l.created_at, t.kind
    FROM wallet_ledger_entries l
    JOIN wager_transactions t ON t.id = l.transaction_id`;

const ENTRY_TYPES: ReadonlySet<string> = new Set(Object.values(LedgerEntryType));

const toEntryType = (kind: string): LedgerEntryType => {
  if (!ENTRY_TYPES.has(kind)) throw new Error(`A ${kind} transaction cannot have a ledger entry`);
  return kind as LedgerEntryType;
};

export const ledgerEntryFromRow = (row: LedgerEntryRow): WalletLedgerEntry => {
  const currency = toText(row.currency, 'wallet_ledger_entries.currency');
  return WalletLedgerEntry.rehydrate({
    seq: toBigInt(row.seq),
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    entryType: toEntryType(row.kind),
    amount: toMoney(row.amount, currency),
    balanceBefore: toMoney(row.balance_before, currency),
    balanceAfter: toMoney(row.balance_after, currency),
    walletVersion: row.wallet_version,
    createdAt: toDate(row.created_at),
  });
};

export const ledgerEntryToInsertParams = (entry: WalletLedgerEntry): unknown[] => [
  entry.walletId,
  entry.transactionId,
  entry.direction,
  entry.amount.amount,
  entry.currency,
  entry.balanceBefore.amount,
  entry.balanceAfter.amount,
  entry.walletVersion,
  entry.createdAt,
];
