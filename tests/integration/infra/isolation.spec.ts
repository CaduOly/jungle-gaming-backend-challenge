import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { CreateQueueCommand, GetQueueUrlCommand, ListQueuesCommand, QueueDoesNotExist, SQSClient } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { postgresUrl, testInfraConfig } from '../../support/infra-config';
import { ResourceScope, settleAllOrThrow } from '../../support/settle';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { createSqsClient, createTestQueues, TestQueuesCreationError, type TestQueues } from '../../support/test-queues';
import { isUuidV7, uuidv7 } from '../../support/uuid';

const connect = async (url: string): Promise<Client> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
};

const dropDatabase = (database: TestDatabase): Promise<void> => database.drop();
const destroyQueues = (queues: TestQueues): Promise<void> => queues.destroy();

const queueNamesWithSuffix = async (suffix: string): Promise<string[]> => {
  const client = createSqsClient();
  try {
    const { QueueUrls } = await client.send(new ListQueuesCommand({ QueueNamePrefix: 'wagering-', MaxResults: 1000 }));
    return (QueueUrls ?? []).filter((url) => url.includes(suffix));
  } finally {
    client.destroy();
  }
};

describe('test isolation helpers', () => {
  const scope = new ResourceScope();

  beforeAll(ensureInfraUp);
  afterEach(() => scope.dispose());

  it('creates a fresh, independent database per call and drops it', async () => {
    const [first, second] = await settleAllOrThrow([
      scope.track(createTestDatabase(), dropDatabase),
      scope.track(createTestDatabase(), dropDatabase),
    ]);
    expect(first.name).not.toBe(second.name);
    expect(first.name).toMatch(/^wagering_test_[0-9a-f]{32}$/);

    const clients = new ResourceScope();
    try {
      const [firstClient, secondClient] = await settleAllOrThrow([
        clients.track(connect(first.url), (client) => client.end()),
        clients.track(connect(second.url), (client) => client.end()),
      ]);
      await firstClient.query('CREATE TABLE marker (id int)');
      const { rows } = await secondClient.query<{ found: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'marker') AS found",
      );
      expect(rows[0]?.found).toBe(false);
    } finally {
      await clients.dispose();
    }

    await settleAllOrThrow([first.drop(), second.drop()]);
    const config = testInfraConfig();
    const admin = await connect(postgresUrl(config, config.postgres.adminDatabase));
    try {
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = ANY($1)', [[first.name, second.name]]);
      expect(rows).toHaveLength(0);
    } finally {
      await admin.end();
    }
  });

  it('creates uniquely suffixed queues and deletes them', async () => {
    const [first, second] = await settleAllOrThrow([
      scope.track(createTestQueues(), destroyQueues),
      scope.track(createTestQueues(), destroyQueues),
    ]);
    expect(first.commands.url).not.toBe(second.commands.url);
    expect(first.commands.url).toEndWith(`wagering-commands-${first.suffix}.fifo`);
    expect(first.events.dlqUrl).toEndWith(`wagering-events-dlq-${first.suffix}.fifo`);

    await settleAllOrThrow([first.destroy(), second.destroy()]);

    const client = createSqsClient();
    try {
      await expect(
        client.send(new GetQueueUrlCommand({ QueueName: `wagering-commands-${first.suffix}.fifo` })),
      ).rejects.toBeInstanceOf(QueueDoesNotExist);
    } finally {
      client.destroy();
    }
  });

  it('deletes the queues already created when a later queue fails', async () => {
    const real = createSqsClient();
    let creates = 0;
    const failingOnEventsDlq = new Proxy(real, {
      get: (target, property, receiver) => {
        if (property !== 'send') return Reflect.get(target, property, receiver);
        return async (command: Parameters<SQSClient['send']>[0]) => {
          if (command instanceof CreateQueueCommand && ++creates === 3) throw new Error('injected failure');
          return target.send(command);
        };
      },
    });

    try {
      const error = await createTestQueues({ client: failingOnEventsDlq }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TestQueuesCreationError);
      expect(creates).toBe(3);
      expect(await queueNamesWithSuffix((error as TestQueuesCreationError).suffix)).toEqual([]);
    } finally {
      real.destroy();
    }
  });

  it('generates time-ordered UUIDv7 ids', () => {
    const ids = Array.from({ length: 100 }, uuidv7);
    expect(ids.every(isUuidV7)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('ensureInfraUp fails with an actionable message when the stack is unreachable', async () => {
    const config = testInfraConfig();
    const down = {
      postgres: { ...config.postgres, port: '1' },
      sqs: { ...config.sqs, endpoint: 'http://127.0.0.1:1' },
    };
    const error = await ensureInfraUp(down).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('PostgreSQL is not reachable at localhost:1');
    expect(message).toContain('SQS is not reachable at http://127.0.0.1:1');
    expect(message).toContain('bun run infra:up');
  });
});
