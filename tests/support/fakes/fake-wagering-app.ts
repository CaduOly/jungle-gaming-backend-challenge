import { ExponentialBackoff } from '../../../src/business/shared/policy/exponential-backoff';
import { GetWagerTransaction } from '../../../src/business/wagering/use-case/get-wager-transaction/get-wager-transaction';
import type {
  ProcessWagerTransactionInput,
  WagerSource,
} from '../../../src/business/wagering/use-case/process-wager-transaction/process-wager-transaction.dto';
import { ProcessWagerTransaction } from '../../../src/business/wagering/use-case/process-wager-transaction/process-wager-transaction';
import { RetryPendingReferences } from '../../../src/business/wagering/use-case/retry-pending-references/retry-pending-references';
import { CreateWallet } from '../../../src/business/wallet/use-case/create-wallet/create-wallet';
import { GetLedger } from '../../../src/business/wallet/use-case/get-ledger/get-ledger';
import { GetWallet } from '../../../src/business/wallet/use-case/get-wallet/get-wallet';
import { ReconcileWallet } from '../../../src/business/wallet/use-case/reconcile-wallet/reconcile-wallet';
import type { WalletView } from '../../../src/business/wallet/use-case/wallet-view';

export type { WalletView };
import { FakeClock } from './fake-clock';
import { FakePayloadHasher } from './fake-payload-hasher';
import { FakeUnitOfWork } from './fake-unit-of-work';
import { InMemoryWagerTransactionRepository } from './in-memory-wager-transaction-repository';
import { InMemoryWalletRepository } from './in-memory-wallet-repository';
import { SequentialUuidGenerator } from './sequential-id-generator';

export interface FakeWageringAppOptions {
  readonly baseMs?: number;
  readonly capMs?: number;
  readonly maxAttempts?: number;
}

/** Every use case wired over one in-memory database, a fake clock, sequential UUID-shaped ids and jitter-free backoff. */
export const createFakeWageringApp = (options: FakeWageringAppOptions = {}) => {
  const uow = new FakeUnitOfWork();
  const { db } = uow;
  const clock = new FakeClock();
  const ids = new SequentialUuidGenerator();
  const hasher = new FakePayloadHasher();
  const backoff = new ExponentialBackoff({
    baseMs: options.baseMs ?? 2_000,
    capMs: options.capMs ?? 60_000,
    maxAttempts: options.maxAttempts ?? 4,
    random: () => 0,
  });
  return {
    uow,
    db,
    clock,
    ids,
    hasher,
    backoff,
    process: new ProcessWagerTransaction(uow, hasher, clock, ids, backoff),
    retry: new RetryPendingReferences(uow, clock, ids, backoff, { batchSize: 50, leaseMs: 30_000 }),
    createWallet: new CreateWallet(uow, hasher, clock, ids),
    getWallet: new GetWallet(new InMemoryWalletRepository(db.wallets)),
    getLedger: new GetLedger(new InMemoryWalletRepository(db.wallets), db.ledger),
    reconcile: new ReconcileWallet(uow),
    getTransaction: new GetWagerTransaction(new InMemoryWagerTransactionRepository(db.wagers)),
  };
};

export type FakeWageringApp = ReturnType<typeof createFakeWageringApp>;

export interface SubmissionOptions {
  readonly amount?: string;
  readonly currency?: string;
  readonly reference?: string;
  readonly providerId?: string;
  readonly actor?: string;
  readonly key?: string;
  readonly roundId?: string;
  readonly playerId?: string;
  readonly source?: WagerSource;
  readonly correlationId?: string;
}

/** A submission as the HTTP controller would build it (key defaults to `{providerId}:{externalTransactionId}`). */
export const aSubmission = (
  wallet: Pick<WalletView, 'id' | 'playerId'>,
  kind: string,
  externalTransactionId: string,
  options: SubmissionOptions = {},
): ProcessWagerTransactionInput => {
  const providerId = options.providerId ?? 'provider-a';
  return {
    actor: { providerId: options.actor ?? providerId },
    idempotencyKey: options.key ?? `${providerId}:${externalTransactionId}`,
    source: options.source ?? { channel: 'HTTP' },
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    payload: {
      providerId,
      externalTransactionId,
      playerId: options.playerId ?? wallet.playerId,
      walletId: wallet.id,
      roundId: options.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount: options.amount ?? '10.00', currency: options.currency ?? 'BRL' },
      ...(options.reference === undefined ? {} : { referenceExternalTransactionId: options.reference }),
    },
  };
};
