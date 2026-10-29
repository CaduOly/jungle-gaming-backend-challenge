import { Wallet } from '../../../wallet/entity/wallet';
import { LedgerDirection } from '../../../wallet/enum/ledger-direction';
import type { IWalletRepository } from '../../../wallet/port/wallet.repository.port';

export const process = (repository: IWalletRepository): [Wallet, LedgerDirection] => {
  void repository;
  return [new Wallet(), LedgerDirection.Debit];
};
