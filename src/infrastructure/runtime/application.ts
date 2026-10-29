import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { TxRepositories } from '../../business/wagering/port/tx-repositories.port';
import { SystemClock } from '../clock/system-clock';
import { type AppRole, readAppRoles, readInstanceId } from '../config/app-roles';
import { readDatabaseConfig } from '../config/database-config';
import { readOutboxPublisherConfig } from '../config/outbox-publisher-config';
import { readPendingReferenceBackoff } from '../config/pending-reference-config';
import { readPendingReferenceWorkerConfig } from '../config/pending-reference-worker-config';
import { readSqsConfig } from '../config/sqs-config';
import { readSqsConsumerConfig } from '../config/sqs-consumer-config';
import { FaultInjector } from '../fault-injection/fault-injector';
import { type RunningHttpApi, startHttpApi } from '../framework/nest/shared/http-api';
import { readHttpConfig } from '../framework/nest/shared/http-config';
import { PostgresReadinessCheck } from '../health/postgres-readiness-check';
import type { IReadinessCheck } from '../health/readiness-check.port';
import { withTimeout } from '../health/readiness-probe';
import { SqsReadinessCheck } from '../health/sqs-readiness-check';
import { UuidV7IdGenerator } from '../id/uuid-v7-id-generator';
import { createOutboxPublisherWorker } from '../messaging/outbox/outbox-publisher-worker.factory';
import { createSqsClient } from '../messaging/sqs/sqs-client';
import type { SqsConsumerLoop } from '../messaging/sqs/sqs-consumer-loop';
import { SqsMessagePublisher } from '../messaging/sqs/sqs-message-publisher';
import { SqsQueueUrl } from '../messaging/sqs/sqs-queue-url';
import { createObservability, type Observability } from '../observability/observability';
import { createMikroOrmConfig } from '../persistence/mikro-orm/mikro-orm.config';
import { createPostgresReadiness } from '../persistence/mikro-orm/postgres-readiness';
import { createReadRepositories, createTxRepositories } from '../persistence/mikro-orm/repository/wagering-repositories';
import { MikroOrmUnitOfWork } from '../persistence/mikro-orm/unit-of-work';
import { createPendingReferenceWorker } from '../wagering/pending-reference-worker.factory';
import { createWagerCommandConsumer } from '../wagering/wager-command-consumer.factory';

type Env = Readonly<Record<string, string | undefined>>;

export interface RunningApplication {
  readonly instanceId: string;
  readonly roles: ReadonlySet<AppRole>;
  readonly httpPort: number | undefined;
  /**
   * Stops the HTTP server and every loop, lets the work in flight finish (the consumer within SHUTDOWN_TIMEOUT_MS,
   * handing back what it did not start) and only then closes the ORM pool and the SQS client.
   */
  stop(): Promise<void>;
}

interface Stoppable {
  readonly name: string;
  stop(): Promise<unknown>;
}

const sqsReadiness = (client: SQSClient, queue: SqsQueueUrl): IReadinessCheck => ({
  name: 'sqs',
  check: async () => new SqsReadinessCheck(client, await queue.get()).check(),
});

/**
 * The composition root of one replica: the real MikroORM persistence, SQS, SHA-256 hashing, UUIDv7 ids and the
 * system clock, with only the roles in APP_ROLES started. Migrations are not run here: `bun run migrate` runs
 * once before the replicas start.
 */
export const startApplication = async (env: Env, observed?: Observability): Promise<RunningApplication> => {
  const roles = readAppRoles(env);
  const instanceId = readInstanceId(env);
  const base = observed ?? createObservability({ env });
  const logger = base.logger.child({ instanceId });
  const observability: Observability = { ...base, logger };
  const { metrics, workers } = observability;
  const database = readDatabaseConfig(env);
  const http = readHttpConfig(env);
  const sqs = readSqsConfig(env);
  const consumerConfig = readSqsConsumerConfig(env);
  const faults = FaultInjector.fromEnv(env);
  const clock = new SystemClock();
  const ids = new UuidV7IdGenerator();

  const orm = await MikroORM.init(createMikroOrmConfig(database.url, { acquireTimeoutMs: database.poolAcquireTimeoutMs }));
  const client = createSqsClient(sqs);
  const postgres = new PostgresReadinessCheck(orm.em);
  const pgReadiness = createPostgresReadiness(orm.em);
  const boundedPgReadiness = () => withTimeout({ name: 'postgres', check: pgReadiness }, http.readinessTimeoutMs);

  let consumer: SqsConsumerLoop | undefined;
  const stoppables: Stoppable[] = [];
  if (roles.has('consumer')) {
    const loop = createWagerCommandConsumer({
      em: orm.em,
      client,
      sqs,
      config: consumerConfig,
      referenceBackoff: readPendingReferenceBackoff(env),
      lockTimeoutMs: database.lockTimeoutMs,
      faults,
      clock,
      ids,
      readiness: boundedPgReadiness,
      handler: {
        onPermanentFailure: (error, message) =>
          logger.error(
            { sqsMessageId: message.sqsMessageId, error: error.name, errorMessage: error.message, sqlState: error.sqlState },
            'command dead-lettered by a permanent infrastructure failure',
          ),
      },
      observability,
      onOutcome: workers.consumerOutcome,
      onError: workers.workerError('consumer'),
      onCircuitStateChange: workers.circuitState('sqs_consumer'),
    });
    consumer = loop;
    stoppables.push({ name: 'consumer', stop: () => loop.stop(consumerConfig.shutdownTimeoutMs) });
  }
  if (roles.has('outbox')) {
    const worker = createOutboxPublisherWorker({
      em: orm.em,
      publisher: new SqsMessagePublisher(client, sqs.eventsQueue),
      clock,
      config: readOutboxPublisherConfig(env),
      faults,
      metrics,
      onRound: (round) => {
        workers.outboxRound(round);
        if (round.claimed > 0) logger.debug({ ...round }, 'outbox round');
      },
      onError: workers.workerError('outbox'),
    });
    stoppables.push({ name: 'outbox', stop: () => worker.stop() });
    worker.start();
  }
  if (roles.has('pending-worker')) {
    const worker = createPendingReferenceWorker({
      em: orm.em,
      clock,
      ids,
      config: readPendingReferenceWorkerConfig(env, database),
      lockTimeoutMs: database.lockTimeoutMs,
      faults,
      metrics,
      onRound: (round) => {
        workers.pendingRound(round);
        if (round.claimed > 0) logger.debug({ ...round }, 'pending reference round');
      },
      onError: workers.workerError('pending-worker'),
    });
    stoppables.push({ name: 'pending-worker', stop: () => worker.stop() });
    worker.start();
  }

  let api: RunningHttpApi | undefined;
  if (roles.has('api')) {
    const commandsQueue = new SqsQueueUrl(client, sqs.commandsQueue, http.readinessTimeoutMs);
    const readers = createReadRepositories(orm.em, clock);
    api = await startHttpApi({
      persistence: {
        unitOfWork: new MikroOrmUnitOfWork<TxRepositories>(orm.em, (em) => createTxRepositories(em, { clock, faults }), {
          lockTimeoutMs: database.lockTimeoutMs,
          faults,
        }),
        wallets: readers.wallets,
        ledger: readers.ledger,
        transactions: readers.wagers,
      },
      readinessChecks: [postgres, sqsReadiness(client, commandsQueue)],
      readinessDetails: () => ({
        instanceId,
        roles: [...roles],
        ...(consumer === undefined ? {} : { circuitBreaker: consumer.isCircuitOpen ? 'open' : 'closed' }),
      }),
      instanceId,
      env,
      observability,
    });
    const running = api;
    stoppables.unshift({ name: 'api', stop: () => running.close() });
  }
  consumer?.start();
  logger.info({ roles: [...roles], ...(api === undefined ? {} : { port: api.port }) }, 'started');

  return {
    instanceId,
    roles,
    httpPort: api?.port,
    stop: async () => {
      logger.info('stopping');
      const results = await Promise.allSettled(stoppables.map((part) => part.stop()));
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          workers.workerError(stoppables[index]?.name ?? 'unknown')(result.reason, 'stop');
        }
      });
      await orm.close(true);
      client.destroy();
      logger.info('stopped');
    },
  };
};
