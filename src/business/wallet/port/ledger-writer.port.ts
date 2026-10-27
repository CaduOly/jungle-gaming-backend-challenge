import type { WalletLedgerEntry } from '../entity/wallet-ledger-entry';

export interface ILedgerWriter {
  /** Insert-only; returns the entry carrying the seq assigned by persistence. */
  append(entry: WalletLedgerEntry): Promise<WalletLedgerEntry>;
}
