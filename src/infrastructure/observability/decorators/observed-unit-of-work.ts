import type { UnitOfWorkOptions } from '../../../business/shared/port/unit-of-work.port';
import type { IWageringUnitOfWork, TxRepositories } from '../../../business/wagering/port/tx-repositories.port';
import type { IWalletRepository } from '../../../business/wallet/port/wallet.repository.port';
import { lockConflictOf } from '../metrics/error-classification';
import type { WageringMetrics } from '../metrics/wagering-metrics';

/**
 * Mede o lock wait da wallet (lock_wait_seconds) e conta os units of work que um conflito de lock abortou
 * (lock_conflicts_total). Fica no unit of work e não num use case, então o caminho HTTP, o consumer e o
 * pending-reference worker são todos contados, inclusive os itens que o worker retenta sozinho.
 */
export class ObservedUnitOfWork implements IWageringUnitOfWork {
  constructor(
    private readonly inner: IWageringUnitOfWork,
    private readonly metrics: WageringMetrics,
  ) {}

  async run<T>(work: (tx: TxRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    try {
      return await this.inner.run((tx) => work(this.observe(tx)), options);
    } catch (error) {
      const conflict = lockConflictOf(error);
      if (conflict !== undefined) this.metrics.lockConflicts.inc({ type: conflict });
      throw error;
    }
  }

  private observe(tx: TxRepositories): TxRepositories {
    const wallets = tx.wallets;
    const lockWait = this.metrics.lockWait;
    const timed: IWalletRepository = {
      lockById: async (id) => {
        const stopTimer = lockWait.startTimer();
        try {
          return await wallets.lockById(id);
        } finally {
          stopTimer();
        }
      },
      findById: (id) => wallets.findById(id),
      existsByPlayerAndCurrency: (playerId, currency) => wallets.existsByPlayerAndCurrency(playerId, currency),
      insert: (wallet) => wallets.insert(wallet),
      update: (wallet, expectedVersion) => wallets.update(wallet, expectedVersion),
    };
    return { wallets: timed, ledger: tx.ledger, wagers: tx.wagers, inbox: tx.inbox, outbox: tx.outbox };
  }
}
