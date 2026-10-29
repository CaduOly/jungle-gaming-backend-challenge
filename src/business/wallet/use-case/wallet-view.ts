import type { MoneyProps } from '../../shared/value-object/money';
import type { Wallet } from '../entity/wallet';
import type { WalletLedgerEntry } from '../entity/wallet-ledger-entry';
import type { LedgerDirection } from '../enum/ledger-direction';
import type { LedgerEntryType } from '../enum/ledger-entry-type';

/** README §9 wallet payload. */
export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export interface LedgerEntryView {
  readonly transactionId: string;
  readonly entryType: LedgerEntryType;
  readonly direction: LedgerDirection;
  readonly amount: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: string;
}

export const toWalletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toProps(),
  version: wallet.version,
});

export const toLedgerEntryView = (entry: WalletLedgerEntry): LedgerEntryView => ({
  transactionId: entry.transactionId,
  entryType: entry.entryType,
  direction: entry.direction,
  amount: entry.amount.toProps(),
  balanceBefore: entry.balanceBefore.toProps(),
  balanceAfter: entry.balanceAfter.toProps(),
  walletVersion: entry.walletVersion,
  createdAt: entry.createdAt.toISOString(),
});
