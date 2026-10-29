import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster, until } from '../multi-instance/support/cluster';

/**
 * `docker pause` freezes the shared PostgreSQL container: every suite using it stalls while this one runs. That is
 * why it lives apart, under `bun run test:chaos`, and must never run alongside other suites. The container name
 * comes from POSTGRES_CONTAINER (default: the compose project's jungle-wagering-postgres-1).
 */
const CONTAINER = process.env.POSTGRES_CONTAINER ?? 'jungle-wagering-postgres-1';

const docker = (...args: string[]): void => {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr.toString()}`);
};

describe('PostgreSQL frozen under three replicas', () => {
  let cluster: Cluster;
  let paused = false;

  const unpause = (): void => {
    if (!paused) return;
    docker('unpause', CONTAINER);
    paused = false;
  };

  beforeAll(async () => {
    cluster = await Cluster.start({ size: 3 });
  });

  afterAll(async () => {
    unpause();
    if (cluster === undefined) return;
    await cluster.assertAllWalletsConsistent();
    await cluster.destroy();
  });

  it('answers 503 + Retry-After, reports not ready, opens the breaker, and processes the queue once it is back', async () => {
    const wallet = await cluster.openWallet(0, '100.00');
    const warmUp = cluster.wager(wallet, 'BET', '1.00');
    expect((await cluster.submitHttp(0, warmUp)).status).toBe(200);

    const queued = Array.from({ length: 4 }, () => cluster.wager(wallet, 'BET', '2.00'));
    const duringOutage = cluster.wager(wallet, 'BET', '3.00');

    docker('pause', CONTAINER);
    paused = true;
    try {
      for (const command of queued) await cluster.submitSqs(command);

      const started = Date.now();
      const answer = await cluster.submitHttp(1, duringOutage);
      expect(answer.status).toBe(503);
      expect(answer.retryAfter).toBe('1');
      expect(Date.now() - started).toBeLessThan(8_000);

      const notReady = new Set<string>();
      const breakerOpen = new Set<string>();
      await until(
        async () => {
          const reports = await Promise.all(cluster.instances.map(async (instance) => ({ instance, report: await instance.ready() })));
          for (const { instance, report } of reports) {
            if (report.status === 503 && (report.body.checks as Record<string, string>).postgres === 'down') notReady.add(instance.id);
            if (report.body.circuitBreaker === 'open') breakerOpen.add(instance.id);
          }
          return notReady.size === cluster.instances.length && breakerOpen.size === cluster.instances.length;
        },
        20_000,
        'every replica to report PostgreSQL down and open its breaker',
      );
      await Bun.sleep(2_000);
      expect(await cluster.deadLetters()).toEqual([]);
    } finally {
      unpause();
    }

    await Promise.all(cluster.instances.map((instance) => instance.waitReady(30_000)));
    await until(() => cluster.quiescent(), 60_000, 'the queued commands once PostgreSQL is back');
    const retried = await cluster.submitHttp(2, duringOutage);
    expect(retried.status).toBe(200);

    const ids = [...queued, duringOutage].map((command) => command.externalTransactionId);
    expect(await cluster.count(`wager_transactions WHERE external_transaction_id = ANY($1) AND status = 'PROCESSED'`, [ids])).toBe(ids.length);
    expect(await cluster.deadLetters()).toEqual([]);
    const reconciliation = await cluster.http(0, 'POST', `/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.body.data).toMatchObject({ consistent: true });
    const ready = await Promise.all(cluster.instances.map((instance) => instance.ready()));
    expect(ready.map((report) => report.body.circuitBreaker)).toEqual(['closed', 'closed', 'closed']);
  }, 170_000);
});
