import { Wallet } from '../../../wallet/entity/wallet';
import type { IWalletRepository } from '../../../wallet/port/wallet.repository.port';

export const process = (repository: IWalletRepository): Wallet => {
  void repository;
  return new Wallet();
};
