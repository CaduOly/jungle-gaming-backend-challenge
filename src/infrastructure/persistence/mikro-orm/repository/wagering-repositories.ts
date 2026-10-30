import type { EntityManager } from '@mikro-orm/postgresql';
import type { IClock } from '../../../../business/shared/port/clock.port';
import type { IWagerTransactionRepository } from '../../../../business/wagering/port/wager-transaction.repository.port';
import type { TxRepositories } from '../../../../business/wagering/port/tx-repositories.port';
import type { ILedgerReader } from '../../../../business/wallet/port/ledger-reader.port';
import type { IWalletRepository } from '../../../../business/wallet/port/wallet.repository.port';
import { FaultInjector } from '../../../fault-injection/fault-injector';
import { LedgerRepository } from './ledger.repository';
import { createMessagingRepositories } from './messaging-repositories';
import { WagerTransactionRepository } from './wager-transaction.repository';
import { WalletRepository } from './wallet.repository';

export interface TxRepositoriesDependencies {
  readonly clock: IClock;
  readonly faults?: FaultInjector;
}

/** O TxRepositoriesFactory do unit of work de wagering: todo repository ligado ao em transacional. */
export const createTxRepositories = (
  em: EntityManager,
  { clock, faults = FaultInjector.none() }: TxRepositoriesDependencies,
): TxRepositories => ({
  ...createMessagingRepositories(em, faults),
  wallets: new WalletRepository(em),
  ledger: new LedgerRepository(em, faults),
  wagers: new WagerTransactionRepository(em, clock),
});

export interface ReadRepositories {
  readonly wallets: Pick<IWalletRepository, 'findById'>;
  readonly ledger: Pick<ILedgerReader, 'page' | 'listAll'>;
  readonly wagers: Pick<IWagerTransactionRepository, 'findById' | 'findByExternalId'>;
}

/**
 * Leituras simples fora de qualquer unit of work (GetWallet, GetLedger, GetWagerTransaction): cada query faz
 * autocommit na conexão do pool que estiver livre e nunca segura lock. Cada leitura passa por um fork novo para
 * nada ser compartilhado entre requests.
 */
export const createReadRepositories = (em: EntityManager, clock: IClock): ReadRepositories => ({
  wallets: { findById: (id) => new WalletRepository(em.fork()).findById(id) },
  ledger: {
    page: (query) => new LedgerRepository(em.fork()).page(query),
    listAll: (walletId) => new LedgerRepository(em.fork()).listAll(walletId),
  },
  wagers: {
    findById: (id) => new WagerTransactionRepository(em.fork(), clock).findById(id),
    findByExternalId: (providerId, externalId) =>
      new WagerTransactionRepository(em.fork(), clock).findByExternalId(providerId, externalId),
  },
});
