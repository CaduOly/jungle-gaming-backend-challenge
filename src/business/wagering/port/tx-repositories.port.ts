import type { IInboxRepository } from '../../messaging/port/inbox.repository.port';
import type { IOutboxRepository } from '../../messaging/port/outbox.repository.port';
import type { IUnitOfWork } from '../../shared/port/unit-of-work.port';
import type { ILedgerReader } from '../../wallet/port/ledger-reader.port';
import type { ILedgerWriter } from '../../wallet/port/ledger-writer.port';
import type { IWalletRepository } from '../../wallet/port/wallet.repository.port';
import type { IWagerTransactionRepository } from './wager-transaction.repository.port';

/**
 * Repositories bound to one unit of work: everything they write commits or rolls back together.
 * Lives in wagering (not in the shared kernel, which imports no context) because the wager flow is the one that
 * spans every context; wallet use cases reach it through this port.
 */
export interface TxRepositories {
  readonly wallets: IWalletRepository;
  readonly ledger: ILedgerWriter & ILedgerReader;
  readonly wagers: IWagerTransactionRepository;
  readonly inbox: IInboxRepository;
  readonly outbox: Pick<IOutboxRepository, 'add'>;
}

export type IWageringUnitOfWork = IUnitOfWork<TxRepositories>;
