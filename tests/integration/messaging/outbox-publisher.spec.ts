import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../../src/business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../../src/business/messaging/port/message-publisher.port';
import type { PublishOutboxBatchOutput } from '../../../src/business/messaging/use-case/publish-outbox-batch/publish-outbox-batch';
import { SystemClock } from '../../../src/infrastructure/clock/system-clock';
import type { OutboxPublisherConfig } from '../../../src/infrastructure/config/outbox-publisher-config';
import type { SqsQueueRef } from '../../../src/infrastructure/config/sqs-config';
import { createOutboxPublisherWorker } from '../../../src/infrastructure/messaging/outbox/outbox-publisher-worker.factory';
import { createSqsClient, type SqsClientConfig } from '../../../src/infrastructure/messaging/sqs/sqs-client';
import { SqsMessagePublisher } from '../../../src/infrastructure/messaging/sqs/sqs-message-publisher';
import { OutboxRepository } from '../../../src/infrastructure/persistence/mikro-orm/repository/outbox.repository';
import { FakeClock } from '../../support/fakes/fake-clock';
import { aFakeEvent } from '../../support/fakes/fake-integration-event';
import { testInfraConfig } from '../../support/infra-config';
import { TestEventConsumer } from '../../support/test-event-consumer';
import { createTestQueues, type TestQueues } from '../../support/test-queues';
import { uuidv7 } from '../../support/uuid';
import { createOrmDatabase, type OrmDatabase } from '../persistence/messaging-orm';

const DEAD_ENDPOINT = 'http://127.0.0.1:1';
const PROCESS_SCRIPT = new URL('./outbox-publisher-process.ts', import.meta.url).pathname;

const sqsConfig = (endpoint = testInfraConfig().sqs.endpoint): SqsClientConfig => {
  const { region, accessKeyId, secretAccessKey } = testInfraConfig().sqs;
  return { endpoint, region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 };
};

const publisherConfig = (overrides: Partial<OutboxPublisherConfig> = {}): OutboxPublisherConfig => ({
  leaseMs: 10_000,
  batchSize: 5,
  pollIntervalMs: 10,
  backoff: { baseMs: 50, capMs: 1_000, maxAttempts: 5 },
  ...overrides,
});

const seed = async (orm: MikroORM, aggregates: number, perAggregate: number, at = new Date()) => {
  const messages: OutboxMessage[] = [];
  for (let a = 0; a < aggregates; a++) {
    const walletId = uuidv7();
    for (let version = 1; version <= perAggregate; version++) {
      messages.push(
        OutboxMessage.fromEvent(
          aFakeEvent({
            eventId: uuidv7(),
            aggregateId: walletId,
            occurredAt: new Date(at.getTime() - 60_000 + version),
            data: { walletId, amount: '1.00', walletVersion: version },
          }),
        ),
      );
    }
  }
  await new OutboxRepository(orm.em.fork()).add(messages);
  return messages;
};

const pendingCount = async (orm: MikroORM): Promise<number> => {
  const [row] = await orm.em
    .fork()
    .execute<{ pending: string }[]>('SELECT count(*)::text AS pending FROM outbox_messages WHERE published_at IS NULL');
  return row?.pending === undefined ? -1 : Number.parseInt(row.pending, 10);
};

const until = async (condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

const switchable = (initial: IMessagePublisher) => {
  let current = initial;
  return {
    publisher: { publish: (message: OutboxMessage) => current.publish(message) } satisfies IMessagePublisher,
    switchTo: (next: IMessagePublisher) => {
      current = next;
    },
  };
};

describe('outbox publisher against PostgreSQL and LocalStack SQS', () => {
  let db: OrmDatabase;
  let queues: TestQueues;
  const clients: Array<{ destroy(): void }> = [];

  const realPublisher = (queue: SqsQueueRef = { url: queues.events.url }): SqsMessagePublisher => {
    const client = createSqsClient(sqsConfig());
    clients.push(client);
    return new SqsMessagePublisher(client, queue);
  };

  const deadPublisher = (): SqsMessagePublisher => {
    const queue = { url: queues.events.url };
    const client = createSqsClient(sqsConfig(DEAD_ENDPOINT));
    clients.push(client);
    return new SqsMessagePublisher(client, queue, { requestTimeoutMs: 2_000 });
  };

  beforeAll(async () => {
    db = await createOrmDatabase();
  });

  beforeEach(async () => {
    await db.orm.em.fork().execute('DELETE FROM outbox_messages');
    queues = await createTestQueues();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy();
    await queues?.destroy();
  });

  afterAll(() => db?.close());

  it('3 workers on separate pools publish every message at least once and leave nothing pending', async () => {
    const messages = await seed(db.orm, 6, 10);
    const orms = await Promise.all([db.connect(), db.connect(), db.connect()]);
    const rounds: PublishOutboxBatchOutput[][] = orms.map(() => []);
    const errors: unknown[] = [];
    const workers = orms.map((orm, index) =>
      createOutboxPublisherWorker({
        em: orm.em,
        publisher: realPublisher(),
        clock: new SystemClock(),
        config: publisherConfig(),
        onRound: (round) => rounds[index]?.push(round),
        onError: (error) => errors.push(error),
      }),
    );

    workers.forEach((worker) => worker.start());
    try {
      await until(async () => (await pendingCount(db.orm)) === 0, 30_000, 'the outbox to drain');
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }

    expect(errors).toEqual([]);
    const publishedBy = rounds.map((worker) => worker.reduce((sum, round) => sum + round.published, 0));
    expect(publishedBy.reduce((sum, published) => sum + published, 0)).toBeGreaterThanOrEqual(messages.length);
    expect(publishedBy.every((published) => published > 0)).toBe(true);

    const consumer = new TestEventConsumer(queues.client, queues.events.url);
    const collector = await consumer.drainUntilReceived(messages.map((message) => message.id));
    expect(collector.eventIds()).toEqual(new Set(messages.map((message) => message.id)));
    for (const delivery of collector.deliveries) {
      expect(delivery.deduplicationId).toBe(delivery.envelope.eventId);
      expect(delivery.messageGroupId).toBe(delivery.envelope.aggregateId);
    }
    for (const aggregateId of new Set(messages.map((message) => message.aggregateId))) {
      const versions = collector.byAggregate(aggregateId).map((event) => (event.data as { walletVersion: number }).walletVersion);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  });

  it('republishes after a SIGKILL between publish and mark, once the lease expires', async () => {
    const leaseMs = 1_500;
    const messages = await seed(db.orm, 1, 3);
    const [crashed] = messages;
    if (crashed === undefined) throw new Error('nothing seeded');
    const { region, accessKeyId, secretAccessKey, endpoint } = testInfraConfig().sqs;

    const child = Bun.spawn([process.execPath, 'run', PROCESS_SCRIPT], {
      env: {
        ...process.env,
        DATABASE_URL: db.database.url,
        SQS_ENDPOINT: endpoint,
        AWS_REGION: region,
        AWS_ACCESS_KEY_ID: accessKeyId,
        AWS_SECRET_ACCESS_KEY: secretAccessKey,
        SQS_EVENTS_QUEUE_URL: queues.events.url,
        OUTBOX_LEASE_MS: `${leaseMs}`,
        OUTBOX_BATCH_SIZE: '1',
        FAULT_INJECTION: 'crash_after_publish_before_mark',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const killer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    try {
      await child.exited;
    } finally {
      clearTimeout(killer);
    }
    expect(child.signalCode).toBe('SIGKILL');

    const leased = await new OutboxRepository(db.orm.em.fork()).findById(crashed.id);
    expect(leased?.isPending()).toBe(true);
    expect(leased?.attempts).toBe(0);
    expect(leased?.lockedUntil).toBeDefined();

    const worker = createOutboxPublisherWorker({
      em: db.orm.em,
      publisher: realPublisher(),
      clock: new SystemClock(),
      config: publisherConfig({ leaseMs, batchSize: 10 }),
    });
    const beforeExpiry = await worker.runOnce();
    expect(beforeExpiry.published).toBe(2);
    expect((await new OutboxRepository(db.orm.em.fork()).findById(crashed.id))?.isPending()).toBe(true);

    await Bun.sleep(Math.max(0, (leased?.lockedUntil?.getTime() ?? 0) - Date.now()) + 50);
    const afterExpiry = await worker.runOnce();
    expect(afterExpiry).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(await pendingCount(db.orm)).toBe(0);

    const collector = await new TestEventConsumer(queues.client, queues.events.url).drainUntilReceived(
      messages.map((message) => message.id),
    );
    expect(collector.deliveriesOf(crashed.id).length).toBeGreaterThanOrEqual(1);
    expect(collector.events().filter((event) => event.eventId === crashed.id)).toHaveLength(1);
    expect(collector.byAggregate(crashed.aggregateId).map((event) => event.eventId)).toEqual(
      messages.map((message) => message.id),
    );
  });

  it('backs off while SQS is unreachable and publishes once it is back', async () => {
    const clock = new FakeClock(new Date());
    const [message] = await seed(db.orm, 1, 1, clock.now());
    if (message === undefined) throw new Error('nothing seeded');
    const sqs = switchable(deadPublisher());
    const worker = createOutboxPublisherWorker({
      em: db.orm.em,
      publisher: sqs.publisher,
      clock,
      random: () => 0.5,
      config: publisherConfig({ backoff: { baseMs: 1_000, capMs: 8_000, maxAttempts: 5 } }),
    });
    const stored = () => new OutboxRepository(db.orm.em.fork()).findById(message.id);

    expect(await worker.runOnce()).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    let row = await stored();
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt.getTime()).toBe(clock.now().getTime() + 750);
    expect(row?.lockedUntil).toBeUndefined();

    expect(await worker.runOnce()).toMatchObject({ claimed: 0 });

    clock.advance(750);
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, failed: 1 });
    row = await stored();
    expect(row?.attempts).toBe(2);
    expect(row?.nextAttemptAt.getTime()).toBe(clock.now().getTime() + 1_500);

    sqs.switchTo(realPublisher({ name: queues.events.url.split('/').pop() ?? '' }));
    clock.advance(1_500);
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    row = await stored();
    expect(row?.isPending()).toBe(false);
    expect(row?.attempts).toBe(2);

    const collector = await new TestEventConsumer(queues.client, queues.events.url).drainUntilReceived([message.id]);
    expect(collector.events().map((event) => event.eventId)).toEqual([message.id]);
  });

  it('reports a message that exhausts its attempts exactly once and keeps retrying it', async () => {
    const clock = new FakeClock(new Date());
    const [message] = await seed(db.orm, 1, 1, clock.now());
    if (message === undefined) throw new Error('nothing seeded');
    const worker = createOutboxPublisherWorker({
      em: db.orm.em,
      publisher: deadPublisher(),
      clock,
      random: () => 0.5,
      config: publisherConfig({ backoff: { baseMs: 100, capMs: 100, maxAttempts: 2 } }),
    });

    const outputs: PublishOutboxBatchOutput[] = [];
    for (let round = 0; round < 5; round++) {
      outputs.push(await worker.runOnce());
      clock.advance(1_000);
    }

    expect(outputs.map((output) => output.failed)).toEqual([1, 1, 1, 1, 1]);
    expect(outputs.map((output) => output.exhausted)).toEqual([0, 1, 0, 0, 0]);
    expect(outputs.flatMap((output) => output.exhaustedMessageIds)).toEqual([message.id]);
    const row = await new OutboxRepository(db.orm.em.fork()).findById(message.id);
    expect(row?.isPending()).toBe(true);
    expect(row?.attempts).toBe(5);
  });
});
