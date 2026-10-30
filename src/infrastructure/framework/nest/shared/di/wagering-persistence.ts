import type { IWagerTransactionRepository } from '../../../../../business/wagering/port/wager-transaction.repository.port';
import type { IWageringUnitOfWork } from '../../../../../business/wagering/port/tx-repositories.port';
import type { ILedgerReader } from '../../../../../business/wallet/port/ledger-reader.port';
import type { IWalletRepository } from '../../../../../business/wallet/port/wallet.repository.port';

/**
 * Tudo que os use cases HTTP precisam do storage, atrás de um provider só (WAGERING_PERSISTENCE). As suites e2e
 * fazem o bind nos fakes in-memory, os adapters PostgreSQL fazem no MikroORM.
 */
export interface WageringPersistence {
  readonly unitOfWork: IWageringUnitOfWork;
  readonly wallets: Pick<IWalletRepository, 'findById'>;
  readonly ledger: Pick<ILedgerReader, 'page'>;
  readonly transactions: Pick<IWagerTransactionRepository, 'findById' | 'findByExternalId'>;
}
