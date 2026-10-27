import type { EntityManager } from '@mikro-orm/postgresql';
import type { IMessagePublisher } from '../../../business/messaging/port/message-publisher.port';
import { PublishOutboxBatch } from '../../../business/messaging/use-case/publish-outbox-batch/publish-outbox-batch';
import type { IClock } from '../../../business/shared/port/clock.port';
import { ExponentialBackoff } from '../../../business/shared/policy/exponential-backoff';
import type { OutboxPublisherConfig } from '../../config/outbox-publisher-config';
import { FaultInjector } from '../../fault-injection/fault-injector';
import { OutboxRepository } from '../../persistence/mikro-orm/repository/outbox.repository';
import { FaultInjectingMessagePublisher } from '../fault-injecting-message-publisher';
import { OutboxPublisherWorker, type OutboxPublisherWorkerOptions } from './outbox-publisher-worker';

export interface OutboxPublisherWorkerDeps {
  readonly em: EntityManager;
  readonly publisher: IMessagePublisher;
  readonly clock: IClock;
  readonly config: OutboxPublisherConfig;
  readonly faults?: FaultInjector;
  readonly random?: () => number;
  readonly onRound?: OutboxPublisherWorkerOptions['onRound'];
  readonly onError?: OutboxPublisherWorkerOptions['onError'];
}

/**
 * The outbox repository runs on a plain fork, outside any unit of work: claimBatch, markPublished and
 * scheduleRetry are each a single autocommitted statement, so a lease is visible to the other instances
 * as soon as it is taken and no transaction stays open while SQS is called.
 */
export const createOutboxPublisherWorker = (deps: OutboxPublisherWorkerDeps): OutboxPublisherWorker => {
  const faults = deps.faults ?? FaultInjector.none();
  const backoff = new ExponentialBackoff({ ...deps.config.backoff, random: deps.random ?? Math.random });
  const publisher = new FaultInjectingMessagePublisher(deps.publisher, faults);
  const batch = { batchSize: deps.config.batchSize, leaseMs: deps.config.leaseMs };
  return new OutboxPublisherWorker(
    () => new PublishOutboxBatch(new OutboxRepository(deps.em.fork(), faults), publisher, deps.clock, backoff, batch),
    {
      pollIntervalMs: deps.config.pollIntervalMs,
      ...(deps.onRound === undefined ? {} : { onRound: deps.onRound }),
      ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    },
  );
};
