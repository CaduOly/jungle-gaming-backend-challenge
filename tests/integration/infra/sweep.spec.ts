import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { ResourceScope, settleAllOrThrow } from '../../support/settle';
import {
  isSweepable,
  suffixCreatedAt,
  sweepTestResources,
  testResourceSuffix,
} from '../../support/sweep-test-resources';
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

  describe('isSweepable (pure, with an injected now)', () => {
    const suffix = uniqueSuffix();
    const createdAt = suffixCreatedAt(suffix);
    const name = `wagering_test_${suffix}`;
    const HOUR = 60 * 60 * 1000;

    it('keeps resources younger than the minimum age and sweeps older ones', () => {
      expect(isSweepable(name, { minAgeMs: HOUR, now: createdAt + HOUR - 1 })).toBe(false);
      expect(isSweepable(name, { minAgeMs: HOUR, now: createdAt + HOUR })).toBe(true);
    });

    it('applies onlySuffixes together with the age check', () => {
      const old = createdAt + 2 * HOUR;
      expect(isSweepable(name, { minAgeMs: HOUR, now: old, onlySuffixes: new Set([uniqueSuffix()]) })).toBe(false);
      expect(isSweepable(name, { minAgeMs: HOUR, now: old, onlySuffixes: new Set([suffix]) })).toBe(true);
      expect(isSweepable(name, { minAgeMs: HOUR, now: createdAt, onlySuffixes: new Set([suffix]) })).toBe(false);
    });

    it('never sweeps a compose resource, whatever the age', () => {
      for (const compose of ['wagering', 'wagering-events.fifo', 'wagering-commands-dlq.fifo']) {
        expect(isSweepable(compose, { minAgeMs: 0, now: Number.MAX_SAFE_INTEGER })).toBe(false);
      }
    });
  });

  it('drops leaked databases and queues without touching the compose queues', async () => {
    const [database, queues] = await settleAllOrThrow([
      scope.track(createTestDatabase(), (db: TestDatabase) => db.drop()),
      scope.track(createTestQueues(), (q: TestQueues) => q.destroy()),
    ]);
    const suffix = testResourceSuffix(database.name);
    expect(suffix).toBeDefined();

    const ownSuffixes = new Set([database.name.slice(-32), queues.suffix]);
    const report = await sweepTestResources({ minAgeMs: 0, onlySuffixes: ownSuffixes });

    expect(report.databases).toEqual([database.name]);
    expect([...report.queues].sort()).toEqual(
      [
        `wagering-commands-${queues.suffix}.fifo`,
        `wagering-commands-dlq-${queues.suffix}.fifo`,
        `wagering-events-${queues.suffix}.fifo`,
        `wagering-events-dlq-${queues.suffix}.fifo`,
      ].sort(),
    );
    const again = await sweepTestResources({ minAgeMs: 0, onlySuffixes: ownSuffixes });
    expect(again).toEqual({ databases: [], queues: [] });
  });
});
