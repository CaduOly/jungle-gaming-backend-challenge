import type { EntityManager } from '@mikro-orm/postgresql';
import type { IClock } from '../../business/shared/port/clock.port';
import type { IIdGenerator } from '../../business/shared/port/id-generator.port';
import { ExponentialBackoff } from '../../business/shared/policy/exponential-backoff';
import type { TxRepositories } from '../../business/wagering/port/tx-repositories.port';
import { RetryPendingReferences } from '../../business/wagering/use-case/retry-pending-references/retry-pending-references';
import type { PendingReferenceWorkerConfig } from '../config/pending-reference-worker-config';
import { FaultInjector } from '../fault-injection/fault-injector';
import { createTxRepositories } from '../persistence/mikro-orm/repository/wagering-repositories';
import { MikroOrmUnitOfWork } from '../persistence/mikro-orm/unit-of-work';
import { PendingReferenceWorker, type PendingReferenceWorkerOptions } from './pending-reference-worker';

export interface PendingReferenceWorkerDeps {
  readonly em: EntityManager;
  readonly clock: IClock;
  readonly ids: IIdGenerator;
  readonly config: PendingReferenceWorkerConfig;
  readonly lockTimeoutMs: number;
  readonly faults?: FaultInjector;
  readonly random?: () => number;
  readonly onRound?: PendingReferenceWorkerOptions['onRound'];
  readonly onError?: PendingReferenceWorkerOptions['onError'];
}

/**
 * The real RetryPendingReferences over the MikroORM unit of work: every `run` (the claim, then each item) is its own
 * transaction on a fresh fork, so the use case can be built once and shared by every round.
 */
export const createPendingReferenceWorker = (deps: PendingReferenceWorkerDeps): PendingReferenceWorker => {
  const faults = deps.faults ?? FaultInjector.none();
  const unitOfWork = new MikroOrmUnitOfWork<TxRepositories>(
    deps.em,
    (em) => createTxRepositories(em, { clock: deps.clock, faults }),
    { lockTimeoutMs: deps.lockTimeoutMs, faults },
  );
  const backoff = new ExponentialBackoff({ ...deps.config.backoff, random: deps.random ?? Math.random });
  const retry = new RetryPendingReferences(unitOfWork, deps.clock, deps.ids, backoff, {
    batchSize: deps.config.batchSize,
    leaseMs: deps.config.leaseMs,
  });
  return new PendingReferenceWorker(retry, {
    batchSize: deps.config.batchSize,
    pollIntervalMs: deps.config.pollIntervalMs,
    ...(deps.onRound === undefined ? {} : { onRound: deps.onRound }),
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
  });
};
