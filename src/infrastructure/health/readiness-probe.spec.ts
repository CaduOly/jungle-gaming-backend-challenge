import { describe, expect, it } from 'bun:test';
import type { IReadinessCheck } from './readiness-check.port';
import { ReadinessProbe } from './readiness-probe';

const check = (name: string, outcome: 'up' | 'down' | 'hang'): IReadinessCheck => ({
  name,
  check: () =>
    outcome === 'up' ? Promise.resolve() : outcome === 'down' ? Promise.reject(new Error(`${name} is down`)) : new Promise(() => undefined),
});

describe('ReadinessProbe', () => {
  it('is ready when every check answers', async () => {
    const probe = new ReadinessProbe([check('postgres', 'up'), check('sqs', 'up')], 100);
    expect(await probe.run()).toEqual({ status: 'ready', checks: { postgres: 'up', sqs: 'up' } });
  });

  it('is unavailable when any check fails, and names it', async () => {
    const probe = new ReadinessProbe([check('postgres', 'down'), check('sqs', 'up')], 100);
    expect(await probe.run()).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } });
  });

  it('counts a check that hangs as down once the timeout passes', async () => {
    const probe = new ReadinessProbe([check('postgres', 'hang'), check('sqs', 'up')], 20);
    const started = Date.now();
    expect(await probe.run()).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('is ready with no check at all', async () => {
    expect(await new ReadinessProbe([], 20).run()).toEqual({ status: 'ready', checks: {} });
  });
});
