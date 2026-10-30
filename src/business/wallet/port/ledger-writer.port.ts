import type { WalletLedgerEntry } from '../entity/wallet-ledger-entry';

export interface ILedgerWriter {
  /** Só insert, retorna a entry com o seq atribuído pela persistência. */
  append(entry: WalletLedgerEntry): Promise<WalletLedgerEntry>;
}
