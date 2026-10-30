import type { Provider } from '@nestjs/common';
import type { ExponentialBackoff } from '../../../../../business/shared/policy/exponential-backoff';
import type { IClock } from '../../../../../business/shared/port/clock.port';
import type { IIdGenerator } from '../../../../../business/shared/port/id-generator.port';
import type { IPayloadHasher } from '../../../../../business/wagering/port/payload-hasher.port';
import type { IWageringUnitOfWork } from '../../../../../business/wagering/port/tx-repositories.port';
import { GetWagerTransaction } from '../../../../../business/wagering/use-case/get-wager-transaction/get-wager-transaction';
import { ProcessWagerTransaction } from '../../../../../business/wagering/use-case/process-wager-transaction/process-wager-transaction';
import { CreateWallet } from '../../../../../business/wallet/use-case/create-wallet/create-wallet';
import { GetLedger } from '../../../../../business/wallet/use-case/get-ledger/get-ledger';
import { GetWallet } from '../../../../../business/wallet/use-case/get-wallet/get-wallet';
import { ReconcileWallet } from '../../../../../business/wallet/use-case/reconcile-wallet/reconcile-wallet';
import { ObservedUnitOfWork } from '../../../../observability/decorators/observed-unit-of-work';
import { type ObservabilityTools, observeUseCase } from '../../../../observability/decorators/observe-use-case';
import {
  createWalletObservation,
  getLedgerObservation,
  getWagerTransactionObservation,
  getWalletObservation,
  processWagerTransactionObservation,
  reconcileWalletObservation,
} from '../../../../observability/decorators/use-case-observations';
import type { Logger } from '../../../../observability/logging/logger';
import type { WageringMetrics } from '../../../../observability/metrics/wagering-metrics';
import {
  CLOCK,
  CREATE_WALLET,
  GET_LEDGER,
  GET_WAGER_TRANSACTION,
  GET_WALLET,
  ID_GENERATOR,
  LOGGER,
  METRICS,
  PAYLOAD_HASHER,
  PENDING_REFERENCE_BACKOFF,
  PROCESS_WAGER_TRANSACTION,
  RECONCILE_WALLET,
  UNIT_OF_WORK,
  WAGERING_PERSISTENCE,
} from './tokens';
import type { WageringPersistence } from './wagering-persistence';

const tools = (logger: Logger, metrics: WageringMetrics): ObservabilityTools => ({ logger, metrics });

/**
 * Os use cases ficam sem framework: o Nest só monta eles a partir das ports ligadas aos tokens e embrulha cada um
 * nos decorators de logging e métricas. As escritas passam pelo unit of work observado.
 */
export const useCaseProviders: Provider[] = [
  {
    provide: UNIT_OF_WORK,
    inject: [WAGERING_PERSISTENCE, METRICS],
    useFactory: (persistence: WageringPersistence, metrics: WageringMetrics) =>
      new ObservedUnitOfWork(persistence.unitOfWork, metrics),
  },
  {
    provide: CREATE_WALLET,
    inject: [UNIT_OF_WORK, PAYLOAD_HASHER, CLOCK, ID_GENERATOR, LOGGER, METRICS],
    useFactory: (
      unitOfWork: IWageringUnitOfWork,
      hasher: IPayloadHasher,
      clock: IClock,
      ids: IIdGenerator,
      logger: Logger,
      metrics: WageringMetrics,
    ) => observeUseCase(new CreateWallet(unitOfWork, hasher, clock, ids), tools(logger, metrics), createWalletObservation),
  },
  {
    provide: GET_WALLET,
    inject: [WAGERING_PERSISTENCE, LOGGER, METRICS],
    useFactory: (persistence: WageringPersistence, logger: Logger, metrics: WageringMetrics) =>
      observeUseCase(new GetWallet(persistence.wallets), tools(logger, metrics), getWalletObservation),
  },
  {
    provide: GET_LEDGER,
    inject: [WAGERING_PERSISTENCE, LOGGER, METRICS],
    useFactory: (persistence: WageringPersistence, logger: Logger, metrics: WageringMetrics) =>
      observeUseCase(new GetLedger(persistence.wallets, persistence.ledger), tools(logger, metrics), getLedgerObservation),
  },
  {
    provide: RECONCILE_WALLET,
    inject: [UNIT_OF_WORK, LOGGER, METRICS],
    useFactory: (unitOfWork: IWageringUnitOfWork, logger: Logger, metrics: WageringMetrics) =>
      observeUseCase(new ReconcileWallet(unitOfWork), tools(logger, metrics), reconcileWalletObservation),
  },
  {
    provide: PROCESS_WAGER_TRANSACTION,
    inject: [UNIT_OF_WORK, PAYLOAD_HASHER, CLOCK, ID_GENERATOR, PENDING_REFERENCE_BACKOFF, LOGGER, METRICS],
    useFactory: (
      unitOfWork: IWageringUnitOfWork,
      hasher: IPayloadHasher,
      clock: IClock,
      ids: IIdGenerator,
      backoff: ExponentialBackoff,
      logger: Logger,
      metrics: WageringMetrics,
    ) =>
      observeUseCase(
        new ProcessWagerTransaction(unitOfWork, hasher, clock, ids, backoff),
        tools(logger, metrics),
        processWagerTransactionObservation,
      ),
  },
  {
    provide: GET_WAGER_TRANSACTION,
    inject: [WAGERING_PERSISTENCE, LOGGER, METRICS],
    useFactory: (persistence: WageringPersistence, logger: Logger, metrics: WageringMetrics) =>
      observeUseCase(new GetWagerTransaction(persistence.transactions), tools(logger, metrics), getWagerTransactionObservation),
  },
];
