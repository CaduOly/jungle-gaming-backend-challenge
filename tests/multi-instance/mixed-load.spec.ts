import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster, until } from './support/cluster';

const WALLETS = 9;
const HTTP_PER_WALLET = 6;
const SQS_PER_WALLET = 6;

describe('three replicas over one database and one queue', () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await Cluster.start({ size: 3 });
  });

  afterAll(async () => {
    if (cluster === undefined) return;
    await cluster.assertAllWalletsConsistent();
    await cluster.destroy();
  });

  it('every replica serves part of a mixed HTTP + SQS load, each command applies once and every wallet reconciles', async () => {
    const wallets = await Promise.all(Array.from({ length: WALLETS }, (_, index) => cluster.openWallet(index)));

    const sqsCommands = wallets.flatMap((wallet) =>
      Array.from({ length: SQS_PER_WALLET }, (_, n) => cluster.wager(wallet, n % 2 === 0 ? 'BET' : 'WIN', '1.00')),
    );
    const httpCommands = wallets.flatMap((wallet) =>
      Array.from({ length: HTTP_PER_WALLET }, (_, n) => cluster.wager(wallet, n % 3 === 2 ? 'WIN' : 'BET', '2.00')),
    );
    const sends = sqsCommands.map((data) => cluster.submitSqs(data));
    const answers = await Promise.all(
      httpCommands.flatMap((data, index) => [
        cluster.submitHttp(index, data),
        cluster.submitHttp(index + 1, data),
      ]),
    );
    const duplicateSqs = sqsCommands.slice(0, WALLETS).map((data) => cluster.submitSqs(data));
    await Promise.all([...sends, ...duplicateSqs]);

    const lateBets = wallets.map((wallet) => cluster.wager(wallet, 'BET', '5.00'));
    const earlyRollbacks = await Promise.all(
      lateBets.map((bet, index) =>
        cluster.submitHttp(index, cluster.wager(wallets[index]!, 'ROLLBACK', '5.00', bet.externalTransactionId)),
      ),
    );
    expect(earlyRollbacks.map((answer) => answer.status)).toEqual(lateBets.map(() => 202));
    await Promise.all(lateBets.map((bet) => cluster.submitSqs(bet)));

    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    const servedBy = new Set(answers.map((answer) => answer.instanceId));
    expect(servedBy).toEqual(new Set(cluster.instances.map((instance) => instance.id)));

    await until(() => cluster.quiescent(), 60_000, 'outbox, pending references and the commands queue to drain');

    const sqsProcessors = cluster.instances.filter((instance) => instance.processed().length > 0).map((instance) => instance.id);
    expect(sqsProcessors.length).toBeGreaterThanOrEqual(2);
    const firstApplications = cluster.instances.flatMap((instance) =>
      instance.processed().filter((event) => event.idempotentReplay === false),
    );
    expect(firstApplications).toHaveLength(sqsCommands.length + lateBets.length);
    expect(await cluster.count(`wager_transactions WHERE kind = 'ROLLBACK' AND status = 'PROCESSED'`)).toBe(WALLETS);

    const total = sqsCommands.length + httpCommands.length + 2 * lateBets.length;
    expect(await cluster.count(`wager_transactions WHERE provider_id = 'provider-a'`)).toBe(total);
    expect(await cluster.count(`wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id WHERE t.provider_id = 'provider-a'`)).toBe(total);
    expect(await cluster.deadLetters()).toEqual([]);

    for (const [index, wallet] of wallets.entries()) {
      const reconciliation = await cluster.http(index, 'POST', `/wallets/${wallet.id}/reconciliation`);
      expect(reconciliation.body.data).toMatchObject({ consistent: true });
    }
  }, 120_000);
});
