import type { Wallet } from '../entity/wallet';

/** Restrito à unit of work atual. */
export interface IWalletRepository {
  /** Carrega a wallet segurando um lock exclusivo até a unit of work terminar (SELECT … FOR UPDATE). */
  lockById(id: string): Promise<Wallet | null>;
  findById(id: string): Promise<Wallet | null>;
  existsByPlayerAndCurrency(playerId: string, currency: string): Promise<boolean>;
  /** Lança WalletAlreadyExistsError quando o player já tem wallet nessa moeda. */
  insert(wallet: Wallet): Promise<void>;
  /** Grava saldo e versão, falha quando a versão gravada não é `expectedVersion`. */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}
