import type { IInboxRepository } from '../../messaging/port/inbox.repository.port';
import type { IOutboxRepository } from '../../messaging/port/outbox.repository.port';
import type { IUnitOfWork } from '../../shared/port/unit-of-work.port';
import type { ILedgerReader } from '../../wallet/port/ledger-reader.port';
import type { ILedgerWriter } from '../../wallet/port/ledger-writer.port';
import type { IWalletRepository } from '../../wallet/port/wallet.repository.port';
import type { IWagerTransactionRepository } from './wager-transaction.repository.port';

/**
 * Repositórios presos a uma unit of work: tudo que eles escrevem faz commit ou rollback junto.
 * Fica em wagering (e não no shared kernel, que não importa nenhum contexto) porque o fluxo de aposta é o que
 * atravessa todos os contextos, e os use cases de wallet chegam nele por esse port.
 */
export interface TxRepositories {
  readonly wallets: IWalletRepository;
  readonly ledger: ILedgerWriter & ILedgerReader;
  readonly wagers: IWagerTransactionRepository;
  readonly inbox: IInboxRepository;
  readonly outbox: Pick<IOutboxRepository, 'add'>;
}

export type IWageringUnitOfWork = IUnitOfWork<TxRepositories>;
