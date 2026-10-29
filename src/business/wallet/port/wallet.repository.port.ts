import type { Wallet } from '../entity/wallet';

/** Scoped to the current unit of work. */
export interface IWalletRepository {
  /** Loads the wallet holding an exclusive lock until the unit of work ends (SELECT … FOR UPDATE). */
  lockById(id: string): Promise<Wallet | null>;
  findById(id: string): Promise<Wallet | null>;
  existsByPlayerAndCurrency(playerId: string, currency: string): Promise<boolean>;
  /** Throws WalletAlreadyExistsError when the player already has a wallet in that currency. */
  insert(wallet: Wallet): Promise<void>;
  /** Persists balance and version; fails when the stored version is not `expectedVersion`. */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}
