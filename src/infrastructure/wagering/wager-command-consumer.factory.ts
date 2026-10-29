import type { EntityManager } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { IClock } from '../../business/shared/port/clock.port';
import type { IIdGenerator } from '../../business/shared/port/id-generator.port';
import { ExponentialBackoff } from '../../business/shared/policy/exponential-backoff';
import type { TxRepositories } from '../../business/wagering/port/tx-repositories.port';
import { ProcessWagerTransaction } from '../../business/wagering/use-case/process-wager-transaction/process-wager-transaction';
import { SystemClock } from '../clock/system-clock';
import type { PendingReferenceWorkerConfig } from '../config/pending-reference-worker-config';
import type { SqsConfig } from '../config/sqs-config';
import type { SqsConsumerConfig } from '../config/sqs-consumer-config';
import { FaultInjector } from '../fault-injection/fault-injector';
import { Sha256PayloadHasher } from '../hashing/sha256-payload-hasher';
import { UuidV7IdGenerator } from '../id/uuid-v7-id-generator';
import { FaultInjectingMessageHandler } from '../messaging/sqs/fault-injecting-message-handler';
import { TimeoutMessageHandler } from '../messaging/sqs/timeout-message-handler';
import { SqsConsumerLoop, type SqsConsumerLoopDeps } from '../messaging/sqs/sqs-consumer-loop';
import { createPostgresReadiness } from '../persistence/mikro-orm/postgres-readiness';
import { createTxRepositories } from '../persistence/mikro-orm/repository/wagering-repositories';
import { MikroOrmUnitOfWork } from '../persistence/mikro-orm/unit-of-work';
import { ObservedUnitOfWork } from '../observability/decorators/observed-unit-of-work';
import { type ObservabilityTools, observeUseCase } from '../observability/decorators/observe-use-case';
import { processWagerTransactionObservation } from '../observability/decorators/use-case-observations';
import { WagerCommandHandler, type WagerCommandHandlerOptions } from './wager-command-handler';

export interface WagerCommandConsumerDeps {
  readonly em: EntityManager;
  readonly client: SQSClient;
  readonly sqs: Pick<SqsConfig, 'commandsQueue' | 'commandsDeadLetterQueue'>;
  readonly config: SqsConsumerConfig;
  /** Same backoff as the pending-reference worker: the use case schedules the first retry of a pending reference. */
  readonly referenceBackoff: PendingReferenceWorkerConfig['backoff'];
  readonly lockTimeoutMs: number;
  readonly faults?: FaultInjector;
  readonly clock?: IClock;
  readonly ids?: IIdGenerator;
  readonly random?: () => number;
  /** PostgreSQL by default; injectable so a test can take the database "down" for the consumer alone. */
  readonly readiness?: () => Promise<void>;
  readonly handler?: Pick<WagerCommandHandlerOptions, 'consumerName' | 'onPermanentFailure' | 'onProcessed'>;
  readonly onOutcome?: SqsConsumerLoopDeps['onOutcome'];
  readonly onError?: SqsConsumerLoopDeps['onError'];
  readonly onCircuitStateChange?: SqsConsumerLoopDeps['onCircuitStateChange'];
  /** Logs and metrics around the use case and the unit of work; none when omitted (the tests). */
  readonly observability?: ObservabilityTools;
}

/**
 * The commands consumer over the real stack: ProcessWagerTransaction on the MikroORM unit of work and repositories,
 * SHA-256 hashing, UUIDv7 ids and the system clock, behind the SQS consumer loop whose breaker follows the
 * PostgreSQL readiness. `slow_handler` and `crash_after_commit_before_ack` come from the fault injector.
 */
export const createWagerCommandConsumer = (deps: WagerCommandConsumerDeps): SqsConsumerLoop => {
  const faults = deps.faults ?? FaultInjector.none();
  const clock = deps.clock ?? new SystemClock();
  const random = deps.random ?? Math.random;
  const observability = deps.observability;
  const ormUnitOfWork = new MikroOrmUnitOfWork<TxRepositories>(
    deps.em,
    (em) => createTxRepositories(em, { clock, faults }),
    { lockTimeoutMs: deps.lockTimeoutMs, faults },
  );
  const unitOfWork = observability === undefined ? ormUnitOfWork : new ObservedUnitOfWork(ormUnitOfWork, observability.metrics);
  const useCase = new ProcessWagerTransaction(
    unitOfWork,
    new Sha256PayloadHasher(),
    clock,
    deps.ids ?? new UuidV7IdGenerator(),
    new ExponentialBackoff({ ...deps.referenceBackoff, random }),
  );
  const processWager =
    observability === undefined ? useCase : observeUseCase(useCase, observability, processWagerTransactionObservation);
  const handler = new TimeoutMessageHandler(
    new FaultInjectingMessageHandler(new WagerCommandHandler(processWager, deps.handler ?? {}), faults),
    deps.config.handlerTimeoutMs,
  );
  return new SqsConsumerLoop({
    client: deps.client,
    queue: deps.sqs.commandsQueue,
    deadLetterQueue: deps.sqs.commandsDeadLetterQueue,
    handler,
    config: deps.config,
    readiness: deps.readiness ?? createPostgresReadiness(deps.em),
    clock,
    random,
    faults,
    ...(deps.onOutcome === undefined ? {} : { onOutcome: deps.onOutcome }),
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    ...(deps.onCircuitStateChange === undefined ? {} : { onCircuitStateChange: deps.onCircuitStateChange }),
  });
};
