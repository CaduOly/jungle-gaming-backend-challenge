import { beforeAll, describe, expect, it } from 'bun:test';
import { GetQueueUrlCommand, QueueDoesNotExist } from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { postgresUrl, testInfraConfig } from '../../support/infra-config';
import { createTestDatabase } from '../../support/test-database';
import { createSqsClient, createTestQueues } from '../../support/test-queues';
import { isUuidV7, uuidv7 } from '../../support/uuid';

const connect = async (url: string): Promise<Client> => {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
};

describe('test isolation helpers', () => {
  beforeAll(ensureInfraUp);

  it('creates a fresh, independent database per call and drops it', async () => {
    const [first, second] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    expect(first.name).not.toBe(second.name);
    expect(first.name).toMatch(/^wagering_test_[0-9a-f]{32}$/);

    const firstClient = await connect(first.url);
    const secondClient = await connect(second.url);
    try {
      await firstClient.query('CREATE TABLE marker (id int)');
      const { rows } = await secondClient.query<{ found: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'marker') AS found",
      );
      expect(rows[0]?.found).toBe(false);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }

    await Promise.all([first.drop(), second.drop()]);
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
    const [first, second] = await Promise.all([createTestQueues(), createTestQueues()]);
    expect(first.commands.url).not.toBe(second.commands.url);
    expect(first.commands.url).toEndWith(`wagering-commands-${first.suffix}.fifo`);
    expect(first.events.dlqUrl).toEndWith(`wagering-events-dlq-${first.suffix}.fifo`);

    const queueName = `wagering-commands-${first.suffix}.fifo`;
    await Promise.all([first.destroy(), second.destroy()]);

    const client = createSqsClient();
    try {
      await expect(client.send(new GetQueueUrlCommand({ QueueName: queueName }))).rejects.toBeInstanceOf(QueueDoesNotExist);
    } finally {
      client.destroy();
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
