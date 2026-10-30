import type { IWagerTransactionRepository } from '../../../../../business/wagering/port/wager-transaction.repository.port';
import type { IWageringUnitOfWork } from '../../../../../business/wagering/port/tx-repositories.port';
import type { ILedgerReader } from '../../../../../business/wallet/port/ledger-reader.port';
import type { IWalletRepository } from '../../../../../business/wallet/port/wallet.repository.port';

/**
 * Everything the HTTP use cases need from storage, behind one provider (WAGERING_PERSISTENCE). The e2e
 * suites bind it to the in-memory fakes; the PostgreSQL adapters bind it to MikroORM.
 */
export interface WageringPersistence {
  readonly unitOfWork: IWageringUnitOfWork;
  readonly wallets: Pick<IWalletRepository, 'findById'>;
  readonly ledger: Pick<ILedgerReader, 'page'>;
  readonly transactions: Pick<IWagerTransactionRepository, 'findById' | 'findByExternalId'>;
}
