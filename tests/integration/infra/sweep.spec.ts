import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { ResourceScope, settleAllOrThrow } from '../../support/settle';
import { suffixCreatedAt, sweepTestResources, testResourceSuffix } from '../../support/sweep-test-resources';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { createTestQueues, type TestQueues } from '../../support/test-queues';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { uniqueSuffix } from '../../support/uuid';

describe('test resource sweep', () => {
  const scope = new ResourceScope();

  beforeAll(ensureInfraUp);
  afterEach(() => scope.dispose());

  it.each([
    'wagering-commands.fifo',
    'wagering-commands-dlq.fifo',
    'wagering-events.fifo',
    'wagering-events-dlq.fifo',
    'wagering',
    'wagering_test_',
    'wagering_test_not-a-suffix',
  ])('never treats %s as a test resource', (name) => {
    expect(testResourceSuffix(name)).toBeUndefined();
  });

  it('recognizes test databases and every test queue flavour', () => {
    const suffix = uniqueSuffix();
    const names = [
      `wagering_test_${suffix}`,
      `wagering-commands-${suffix}.fifo`,
      `wagering-commands-dlq-${suffix}.fifo`,
      `wagering-events-${suffix}.fifo`,
      `wagering-events-dlq-${suffix}.fifo`,
    ];
    expect(names.map(testResourceSuffix)).toEqual(names.map(() => suffix));
  });

  it('reads the creation time from the UUIDv7 suffix', () => {
    const before = Date.now();
    const createdAt = suffixCreatedAt(uniqueSuffix());
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('keeps resources younger than the minimum age', async () => {
    const database = await scope.track(createTestDatabase(), (db: TestDatabase) => db.drop());
    const report = await sweepTestResources({ minAgeMs: 60 * 60 * 1000 });
    expect(report.databases).not.toContain(database.name);
  });

  it('drops leaked databases and queues without touching the compose queues', async () => {
    const [database, queues] = await settleAllOrThrow([
      scope.track(createTestDatabase(), (db: TestDatabase) => db.drop()),
      scope.track(createTestQueues(), (q: TestQueues) => q.destroy()),
    ]);
    const suffix = testResourceSuffix(database.name);
    expect(suffix).toBeDefined();

    const report = await sweepTestResources({ onlySuffixes: new Set([database.name.slice(-32), queues.suffix]) });

    expect(report.databases).toEqual([database.name]);
    expect([...report.queues].sort()).toEqual(
      [
        `wagering-commands-${queues.suffix}.fifo`,
        `wagering-commands-dlq-${queues.suffix}.fifo`,
        `wagering-events-${queues.suffix}.fifo`,
        `wagering-events-dlq-${queues.suffix}.fifo`,
      ].sort(),
    );
    const again = await sweepTestResources({ onlySuffixes: new Set([database.name.slice(-32), queues.suffix]) });
    expect(again).toEqual({ databases: [], queues: [] });
  });
});
