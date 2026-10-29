import type { WalletLedgerEntry } from '../entity/wallet-ledger-entry';
import type { LedgerCursor } from '../value-object/ledger-cursor';

export interface LedgerPageQuery {
  walletId: string;
  after: LedgerCursor | null;
  limit: number;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Null when there are no more entries after this page. */
  next: LedgerCursor | null;
}

export interface ILedgerReader {
  /** Entries ordered by seq ascending, strictly after the cursor. */
  page(query: LedgerPageQuery): Promise<LedgerPage>;
  /** Every entry of the wallet ordered by seq ascending, for reconciliation. */
  listAll(walletId: string): Promise<WalletLedgerEntry[]>;
}
