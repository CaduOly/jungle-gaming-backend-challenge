import { WalletNotFoundError } from '../../../shared/error/wallet-not-found-error';
import type { IUseCase } from '../../../shared/use-case';
import type { MoneyProps } from '../../../shared/value-object/money';
import type { IWageringUnitOfWork } from '../../../wagering/port/tx-repositories.port';
import { type Divergence, reconcileWallet } from '../../domain-service/wallet-reconciliation';

export interface ReconcileWalletInput {
  readonly walletId: string;
}

/** Payload de reconciliação do CHALLENGE.md §9 mais as divergências encontradas. */
export interface ReconcileWalletOutput {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps | null;
  readonly difference: MoneyProps | null;
  /** Lido pelo decorator de métrica: um false aqui é contado e logado, nunca corrigido. */
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly divergences: readonly Divergence[];
}

/** Compara a wallet com o ledger inteiro dentro de um snapshot só leitura. Só reporta, nunca corrige. */
export class ReconcileWallet implements IUseCase<ReconcileWalletInput, ReconcileWalletOutput> {
  constructor(private readonly unitOfWork: IWageringUnitOfWork) {}

  async execute({ walletId }: ReconcileWalletInput): Promise<ReconcileWalletOutput> {
    return this.unitOfWork.run(
      async (tx) => {
        const wallet = await tx.wallets.findById(walletId);
        if (wallet === null) throw new WalletNotFoundError(walletId);
        const result = reconcileWallet(wallet, await tx.ledger.listAll(walletId));
        return {
          walletId,
          storedBalance: result.storedBalance.toProps(),
          calculatedBalance: result.calculatedBalance?.toProps() ?? null,
          difference: result.difference?.toProps() ?? null,
          consistent: result.consistent,
          checkedEntries: result.checkedEntries,
          divergences: result.divergences,
        };
      },
      { mode: 'snapshot-read' },
    );
  }
}
