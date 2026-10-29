import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { ProcessWagerTransaction } from '../../../src/business/wagering/use-case/process-wager-transaction/process-wager-transaction';
import { ExponentialBackoff } from '../../../src/business/shared/policy/exponential-backoff';
import { TransientInfrastructureError } from '../../../src/infrastructure/error/transient-infrastructure-error';
import { ObservedUnitOfWork } from '../../../src/infrastructure/observability/decorators/observed-unit-of-work';
import { metricValue } from '../../../src/infrastructure/observability/metrics/metric-value';
import { WageringMetrics } from '../../../src/infrastructure/observability/metrics/wagering-metrics';
import { aSubmission, type WalletView } from '../../support/fakes/fake-wagering-app';
import { FakePayloadHasher } from '../../support/fakes/fake-payload-hasher';
import { UuidIdGenerator } from '../../support/fakes/uuid-id-generator';
import { uuidv7 } from '../../support/uuid';
import { createRealWageringApp, createWageringDatabase, type RealWageringApp, type WageringDatabase } from '../persistence/wagering-orm';

describe('lock metrics over the real PostgreSQL unit of work', () => {
  let db: WageringDatabase;
  let app: RealWageringApp;
  const wallets = new Set<string>();

  beforeAll(async () => {
    db = await createWageringDatabase();
    app = createRealWageringApp(db.orm, { lockTimeoutMs: 200 });
  });

  afterEach(() => db.assertConsistent(wallets));
  afterAll(() => db?.close());

  const observedProcess = (metrics: WageringMetrics) =>
    new ProcessWagerTransaction(
      new ObservedUnitOfWork(app.uow, metrics),
      new FakePayloadHasher(),
      app.clock,
      new UuidIdGenerator(),
      new ExponentialBackoff({ baseMs: 2_000, capMs: 60_000, maxAttempts: 4, random: () => 0 }),
    );

  const open = async (): Promise<WalletView> => {
    const wallet = await app.createWallet.execute({ playerId: uuidv7(), initialBalance: { amount: '100.00', currency: 'BRL' } });
    wallets.add(wallet.id);
    return wallet;
  };

  it('counts a 55P03 as a lock timeout and still observes how long the lock was waited for', async () => {
    const metrics = new WageringMetrics();
    const wallet = await open();
    await db.sql.query('BEGIN');
    await db.sql.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
    try {
      const error = await observedProcess(metrics)
        .execute(aSubmission(wallet, 'BET', uuidv7(), { amount: '10.00' }))
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as TransientInfrastructureError).sqlState).toBe('55P03');
    } finally {
      await db.sql.query('ROLLBACK');
    }

    expect(await metricValue(metrics, 'lock_conflicts_total', { type: 'timeout' })).toBe(1);
    expect(await metricValue(metrics, 'lock_wait_seconds')).toBe(1);
    const waited = (await metrics.lockWait.get()).values.find((value) => value.metricName === 'lock_wait_seconds_sum');
    expect(waited?.value).toBeGreaterThanOrEqual(0.15);
  });

  it('observes an uncontended lock without counting a conflict', async () => {
    const metrics = new WageringMetrics();
    const wallet = await open();

    expect(await observedProcess(metrics).execute(aSubmission(wallet, 'BET', uuidv7(), { amount: '10.00' }))).toMatchObject({
      status: 'PROCESSED',
    });

    expect(await metricValue(metrics, 'lock_wait_seconds')).toBe(1);
    expect(await metricValue(metrics, 'lock_conflicts_total', { type: 'timeout' })).toBe(0);
  });
});
