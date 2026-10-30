import type { WalletLedgerEntry } from '../entity/wallet-ledger-entry';
import type { LedgerCursor } from '../value-object/ledger-cursor';

export interface LedgerPageQuery {
  walletId: string;
  after: LedgerCursor | null;
  limit: number;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Null quando não há mais entries depois dessa página. */
  next: LedgerCursor | null;
}

export interface ILedgerReader {
  /** Entries ordenadas por seq crescente, estritamente depois do cursor. */
  page(query: LedgerPageQuery): Promise<LedgerPage>;
  /** Todas as entries da wallet ordenadas por seq crescente, para a reconciliação. */
  listAll(walletId: string): Promise<WalletLedgerEntry[]>;
}
