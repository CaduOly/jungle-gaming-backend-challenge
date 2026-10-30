import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';
import { PostgresReadinessCheck } from '../../../src/infrastructure/health/postgres-readiness-check';
import { ReadinessProbe } from '../../../src/infrastructure/health/readiness-probe';
import { SqsReadinessCheck } from '../../../src/infrastructure/health/sqs-readiness-check';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { createTestDatabase } from '../../support/test-database';
import { createTestQueues, type TestQueues } from '../../support/test-queues';

describe('readiness checks against the real PostgreSQL and SQS', () => {
  let queues: TestQueues;

  beforeAll(async () => {
    await ensureInfraUp();
    queues = await createTestQueues();
  });

  afterAll(() => queues?.destroy());

  it('PostgreSQL: up while the database answers SELECT 1, down once it is gone', async () => {
    const database = await createTestDatabase();
    const orm = await MikroORM.init(createMikroOrmConfig(database.url));
    try {
      const check = new PostgresReadinessCheck(orm.em);
      await expect(check.check()).resolves.toBeUndefined();

      await database.drop();
      await expect(check.check()).rejects.toThrow();
    } finally {
      await orm.close(true);
      await database.drop();
    }
  });

  it('SQS: up for an existing queue, down for a queue that does not exist', async () => {
    await expect(new SqsReadinessCheck(queues.client, queues.commands.url).check()).resolves.toBeUndefined();
    await expect(new SqsReadinessCheck(queues.client, `${queues.commands.url}-missing`).check()).rejects.toThrow();
  });

  it('the probe over both answers ready, and unavailable naming the queue that is missing', async () => {
    const database = await createTestDatabase();
    const orm = await MikroORM.init(createMikroOrmConfig(database.url));
    try {
      const postgres = new PostgresReadinessCheck(orm.em);
      expect(await new ReadinessProbe([postgres, new SqsReadinessCheck(queues.client, queues.commands.url)], 2_000).run()).toEqual({
        status: 'ready',
        checks: { postgres: 'up', sqs: 'up' },
      });
      expect(
        await new ReadinessProbe([postgres, new SqsReadinessCheck(queues.client, `${queues.commands.url}-missing`)], 2_000).run(),
      ).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
    } finally {
      await orm.close(true);
      await database.drop();
    }
  });
});
