import { beforeAll, describe, expect, it } from 'bun:test';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { createTestDatabase } from '../../support/test-database';
import { createTestQueues } from '../../support/test-queues';

const PARALLEL_RUNS = 5;

describe('parallel test runs sharing one compose stack', () => {
  beforeAll(ensureInfraUp);

  it('never collide on database or queue names', async () => {
    const runs = await Promise.all(
      Array.from({ length: PARALLEL_RUNS }, async () => ({
        database: await createTestDatabase(),
        queues: await createTestQueues(),
      })),
    );
    try {
      expect(new Set(runs.map((run) => run.database.name)).size).toBe(PARALLEL_RUNS);
      expect(new Set(runs.map((run) => run.queues.commands.url)).size).toBe(PARALLEL_RUNS);
    } finally {
      await Promise.all(runs.flatMap((run) => [run.database.drop(), run.queues.destroy()]));
    }
  });
});
