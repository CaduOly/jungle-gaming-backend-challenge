import type { Wallet } from '../entity/wallet';

export interface IWalletRepository {
  lockById(id: string): Promise<Wallet | null>;
}
