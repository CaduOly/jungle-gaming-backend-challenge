import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { ResourceScope, settleAllOrThrow } from '../../support/settle';
import { createTestDatabase } from '../../support/test-database';
import { createTestQueues } from '../../support/test-queues';

const PARALLEL_RUNS = 5;

describe('parallel test runs sharing one compose stack', () => {
  const scope = new ResourceScope();

  beforeAll(ensureInfraUp);
  afterEach(() => scope.dispose());

  it('never collide on database or queue names', async () => {
    const runs = await settleAllOrThrow(
      Array.from({ length: PARALLEL_RUNS }, () =>
        settleAllOrThrow([
          scope.track(createTestDatabase(), (database) => database.drop()),
          scope.track(createTestQueues(), (queues) => queues.destroy()),
        ]),
      ),
    );
    expect(new Set(runs.map(([database]) => database.name)).size).toBe(PARALLEL_RUNS);
    expect(new Set(runs.map(([, queues]) => queues.commands.url)).size).toBe(PARALLEL_RUNS);
  });
});
