import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster, until, type Wallet } from './support/cluster';

const WALLETS = 6;

/** CHALLENGE.md §13.8: the service restarts under load and still ends consistent. */
describe('kill -9 of every replica under a mixed load, then a restart', () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await Cluster.start({ size: 3 });
  });

  afterAll(async () => {
    if (cluster === undefined) return;
    await cluster.assertAllWalletsConsistent();
    await cluster.destroy();
  });

  it('recovers every committed command, applies each one exactly once and reconciles every wallet', async () => {
    const wallets = await Promise.all(Array.from({ length: WALLETS }, (_, index) => cluster.openWallet(index)));
    const sqsCommands: Array<ReturnType<Cluster['wager']>> = [];
    const httpCommands: Array<ReturnType<Cluster['wager']>> = [];
    let loading = true;

    const httpLoad = async (wallet: Wallet, worker: number) => {
      for (let n = 0; loading; n++) {
        const command = cluster.wager(wallet, n % 4 === 3 ? 'WIN' : 'BET', '1.00');
        httpCommands.push(command);
        await cluster.submitHttp(worker + n, command).catch(() => undefined);
        await Bun.sleep(20);
      }
    };
    const sqsLoad = async (wallet: Wallet) => {
      for (let n = 0; loading; n++) {
        const bet = cluster.wager(wallet, 'BET', '1.00');
        const rollback = cluster.wager(wallet, 'ROLLBACK', '1.00', bet.externalTransactionId);
        const pair = n % 3 === 0 ? [rollback, bet] : [bet];
        for (const command of pair) {
          sqsCommands.push(command);
          await cluster.submitSqs(command);
        }
        await Bun.sleep(20);
      }
    };
    const load = Promise.all(wallets.flatMap((wallet, index) => [httpLoad(wallet, index), sqsLoad(wallet)]));

    await until(async () => (await cluster.count('wager_transactions')) > WALLETS + 120, 30_000, 'the load to build up');
    await cluster.killAll('SIGKILL');
    expect(cluster.instances.every((instance) => !instance.running)).toBe(true);
    await Bun.sleep(300);
    loading = false;
    await load;

    await cluster.startAll();
    const resubmitted = await Promise.all(httpCommands.map((command, index) => cluster.submitHttp(index, command)));
    expect(resubmitted.filter((answer) => answer.status !== 200)).toEqual([]);
    await until(() => cluster.quiescent(), 90_000, 'outbox, pending references and the commands queue to drain');

    const all = [...sqsCommands, ...httpCommands];
    const { rows } = await cluster.sql.query<{ external_transaction_id: string; total: number }>(
      `SELECT external_transaction_id, count(*)::int AS total FROM wager_transactions
        WHERE provider_id = 'provider-a' GROUP BY external_transaction_id`,
    );
    const applied = new Map(rows.map((row) => [row.external_transaction_id, row.total]));
    expect(all.filter((command) => applied.get(command.externalTransactionId) !== 1)).toEqual([]);
    expect(applied.size).toBe(all.length);
    expect(await cluster.count(`wager_transactions WHERE status = 'PENDING_REFERENCE'`)).toBe(0);
    const { rows: unsettled } = await cluster.sql.query(
      `SELECT status, failure_code, attempts FROM wager_transactions WHERE kind = 'ROLLBACK' AND status <> 'PROCESSED'`,
    );
    expect(unsettled).toEqual([]);
    expect(await cluster.count('outbox_messages WHERE published_at IS NULL')).toBe(0);
    expect(await cluster.deadLetters()).toEqual([]);

    for (const [index, wallet] of wallets.entries()) {
      const reconciliation = await cluster.http(index, 'POST', `/wallets/${wallet.id}/reconciliation`);
      expect(reconciliation.body.data).toMatchObject({ consistent: true });
    }
  }, 170_000);
});
