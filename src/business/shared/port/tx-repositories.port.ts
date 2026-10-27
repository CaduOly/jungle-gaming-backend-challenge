import type { IInboxRepository } from '../../messaging/port/inbox.repository.port';
import type { IOutboxRepository } from '../../messaging/port/outbox.repository.port';
import type { IWagerTransactionRepository } from '../../wagering/port/wager-transaction.repository.port';
import type { ILedgerReader } from '../../wallet/port/ledger-reader.port';
import type { ILedgerWriter } from '../../wallet/port/ledger-writer.port';
import type { IWalletRepository } from '../../wallet/port/wallet.repository.port';
import type { IUnitOfWork } from './unit-of-work.port';

/** Repositories bound to one unit of work: everything they write commits or rolls back together. */
export interface TxRepositories {
  readonly wallets: IWalletRepository;
  readonly ledger: ILedgerWriter & ILedgerReader;
  readonly wagers: IWagerTransactionRepository;
  readonly inbox: IInboxRepository;
  readonly outbox: Pick<IOutboxRepository, 'add'>;
}

export type IWageringUnitOfWork = IUnitOfWork<TxRepositories>;
