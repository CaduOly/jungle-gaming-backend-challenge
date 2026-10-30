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
import { ObservedUnitOfWork } from '../observability/decorators/observed-unit-of-work';
import type { WageringMetrics } from '../observability/metrics/wagering-metrics';
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
  /** Lock wait e conflitos de lock de cada item, nada é medido quando omitido (os testes). */
  readonly metrics?: WageringMetrics;
}

/**
 * O RetryPendingReferences real em cima do unit of work do MikroORM: cada `run` (o claim, depois cada item) é uma
 * transação própria num fork novo, então o use case pode ser montado uma vez e compartilhado por todas as rodadas.
 */
export const createPendingReferenceWorker = (deps: PendingReferenceWorkerDeps): PendingReferenceWorker => {
  const faults = deps.faults ?? FaultInjector.none();
  const ormUnitOfWork = new MikroOrmUnitOfWork<TxRepositories>(
    deps.em,
    (em) => createTxRepositories(em, { clock: deps.clock, faults }),
    { lockTimeoutMs: deps.lockTimeoutMs, faults },
  );
  const unitOfWork = deps.metrics === undefined ? ormUnitOfWork : new ObservedUnitOfWork(ormUnitOfWork, deps.metrics);
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
