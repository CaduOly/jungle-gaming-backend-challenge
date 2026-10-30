import { Wallet } from '../../../../business/wallet/entity/wallet';
import { toDate, toMoney, toText } from './sql-values';

export interface WalletRow {
  readonly id: string;
  readonly player_id: string;
  readonly currency: string;
  readonly balance: unknown;
  readonly version: number;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export const WALLET_COLUMNS = 'id, player_id, currency, balance, version, created_at, updated_at';

export const walletFromRow = (row: WalletRow): Wallet => {
  const currency = toText(row.currency, 'wallets.currency');
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    balance: toMoney(row.balance, currency),
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
};

export const walletToInsertParams = (wallet: Wallet): unknown[] => [
  wallet.id,
  wallet.playerId,
  wallet.currency,
  wallet.balance.amount,
  wallet.version,
  wallet.createdAt,
  wallet.updatedAt,
];
