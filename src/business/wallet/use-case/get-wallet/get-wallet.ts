import { WalletNotFoundError } from '../../../shared/error/wallet-not-found-error';
import type { IUseCase } from '../../../shared/use-case';
import type { IWalletRepository } from '../../port/wallet.repository.port';
import { toWalletView, type WalletView } from '../wallet-view';

export interface GetWalletInput {
  readonly walletId: string;
}

export class GetWallet implements IUseCase<GetWalletInput, WalletView> {
  constructor(private readonly wallets: Pick<IWalletRepository, 'findById'>) {}

  async execute({ walletId }: GetWalletInput): Promise<WalletView> {
    const wallet = await this.wallets.findById(walletId);
    if (wallet === null) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }
}
