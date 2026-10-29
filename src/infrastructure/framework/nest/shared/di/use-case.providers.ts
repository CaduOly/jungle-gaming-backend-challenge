import type { Provider } from '@nestjs/common';
import type { ExponentialBackoff } from '../../../../../business/shared/policy/exponential-backoff';
import type { IClock } from '../../../../../business/shared/port/clock.port';
import type { IIdGenerator } from '../../../../../business/shared/port/id-generator.port';
import type { IPayloadHasher } from '../../../../../business/wagering/port/payload-hasher.port';
import { GetWagerTransaction } from '../../../../../business/wagering/use-case/get-wager-transaction/get-wager-transaction';
import { ProcessWagerTransaction } from '../../../../../business/wagering/use-case/process-wager-transaction/process-wager-transaction';
import { CreateWallet } from '../../../../../business/wallet/use-case/create-wallet/create-wallet';
import { GetLedger } from '../../../../../business/wallet/use-case/get-ledger/get-ledger';
import { GetWallet } from '../../../../../business/wallet/use-case/get-wallet/get-wallet';
import { ReconcileWallet } from '../../../../../business/wallet/use-case/reconcile-wallet/reconcile-wallet';
import {
  CLOCK,
  CREATE_WALLET,
  GET_LEDGER,
  GET_WAGER_TRANSACTION,
  GET_WALLET,
  ID_GENERATOR,
  PAYLOAD_HASHER,
  PENDING_REFERENCE_BACKOFF,
  PROCESS_WAGER_TRANSACTION,
  RECONCILE_WALLET,
  WAGERING_PERSISTENCE,
} from './tokens';
import type { WageringPersistence } from './wagering-persistence';

/** The use cases stay framework-free: Nest only builds them, from the ports bound to the tokens. */
export const useCaseProviders: Provider[] = [
  {
    provide: CREATE_WALLET,
    inject: [WAGERING_PERSISTENCE, PAYLOAD_HASHER, CLOCK, ID_GENERATOR],
    useFactory: (persistence: WageringPersistence, hasher: IPayloadHasher, clock: IClock, ids: IIdGenerator) =>
      new CreateWallet(persistence.unitOfWork, hasher, clock, ids),
  },
  {
    provide: GET_WALLET,
    inject: [WAGERING_PERSISTENCE],
    useFactory: (persistence: WageringPersistence) => new GetWallet(persistence.wallets),
  },
  {
    provide: GET_LEDGER,
    inject: [WAGERING_PERSISTENCE],
    useFactory: (persistence: WageringPersistence) => new GetLedger(persistence.wallets, persistence.ledger),
  },
  {
    provide: RECONCILE_WALLET,
    inject: [WAGERING_PERSISTENCE],
    useFactory: (persistence: WageringPersistence) => new ReconcileWallet(persistence.unitOfWork),
  },
  {
    provide: PROCESS_WAGER_TRANSACTION,
    inject: [WAGERING_PERSISTENCE, PAYLOAD_HASHER, CLOCK, ID_GENERATOR, PENDING_REFERENCE_BACKOFF],
    useFactory: (
      persistence: WageringPersistence,
      hasher: IPayloadHasher,
      clock: IClock,
      ids: IIdGenerator,
      backoff: ExponentialBackoff,
    ) => new ProcessWagerTransaction(persistence.unitOfWork, hasher, clock, ids, backoff),
  },
  {
    provide: GET_WAGER_TRANSACTION,
    inject: [WAGERING_PERSISTENCE],
    useFactory: (persistence: WageringPersistence) => new GetWagerTransaction(persistence.transactions),
  },
];
