import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from '../../../business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../../business/messaging/port/message-publisher.port';
import type { IWageringUnitOfWork, TxRepositories } from '../../../business/wagering/port/tx-repositories.port';
import { FakeClock } from '../../../../tests/support/fakes/fake-clock';
import { aFakeEvent } from '../../../../tests/support/fakes/fake-integration-event';
import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';
import { metricValue } from '../metrics/metric-value';
import { WageringMetrics } from '../metrics/wagering-metrics';
import { ObservedMessagePublisher } from './observed-message-publisher';
import { ObservedUnitOfWork } from './observed-unit-of-work';

const stubTx = (lockById: () => Promise<null>): TxRepositories =>
  ({
    wallets: {
      lockById,
      findById: async () => null,
      existsByPlayerAndCurrency: async () => false,
      insert: async () => undefined,
      update: async () => undefined,
    },
    ledger: {},
    wagers: {},
    inbox: {},
    outbox: {},
  }) as unknown as TxRepositories;

const unitOfWork = (tx: TxRepositories, failure?: unknown): IWageringUnitOfWork => ({
  run: async (work) => {
    const result = await work(tx);
    if (failure !== undefined) throw failure;
    return result;
  },
});

describe('ObservedUnitOfWork', () => {
  it('observes the wallet lock wait and hands the rest of the repositories through', async () => {
    const metrics = new WageringMetrics();
    const tx = stubTx(async () => {
      await Bun.sleep(5);
      return null;
    });
    const observed = new ObservedUnitOfWork(unitOfWork(tx), metrics);

    const seen = await observed.run(async (scoped) => {
      await scoped.wallets.lockById('wallet-1');
      return scoped;
    });

    expect(await metricValue(metrics, 'lock_wait_seconds')).toBe(1);
    const sum = (await metrics.lockWait.get()).values.find((value) => value.metricName === 'lock_wait_seconds_sum');
    expect(sum?.value).toBeGreaterThan(0.004);
    expect(seen.ledger).toBe(tx.ledger);
    expect(seen.wagers).toBe(tx.wagers);
  });

  it('observes a lock wait that ended in a timeout as well', async () => {
    const metrics = new WageringMetrics();
    const timeout = new TransientInfrastructureError('lock timeout', '55P03', { cause: undefined });
    const observed = new ObservedUnitOfWork(unitOfWork(stubTx(() => Promise.reject(timeout))), metrics);

    await expect(observed.run((scoped) => scoped.wallets.lockById('wallet-1'))).rejects.toBe(timeout);

    expect(await metricValue(metrics, 'lock_wait_seconds')).toBe(1);
    expect(await metricValue(metrics, 'lock_conflicts_total', { type: 'timeout' })).toBe(1);
  });

  it.each([
    ['55P03', 'timeout', 1],
    ['40P01', 'deadlock', 1],
    ['08006', 'timeout', 0],
  ])('counts %p as a %p lock conflict %p time(s)', async (sqlState, type, expected) => {
    const metrics = new WageringMetrics();
    const failure = new TransientInfrastructureError('failure', sqlState, { cause: undefined });
    const observed = new ObservedUnitOfWork(unitOfWork(stubTx(async () => null), failure), metrics);

    await expect(observed.run(async () => 'done')).rejects.toBe(failure);

    expect(await metricValue(metrics, 'lock_conflicts_total', { type })).toBe(expected);
  });
});

describe('ObservedMessagePublisher', () => {
  const message = (occurredAt: Date) =>
    OutboxMessage.fromEvent(aFakeEvent({ occurredAt }));

  it('observes the lag between the commit and the publication', async () => {
    const metrics = new WageringMetrics();
    const clock = new FakeClock(new Date('2026-10-29T12:00:02.500Z'));
    const publisher = new ObservedMessagePublisher({ publish: async () => undefined }, metrics, clock);

    await publisher.publish(message(new Date('2026-10-29T12:00:00.000Z')));

    const sum = (await metrics.outboxLag.get()).values.find((value) => value.metricName === 'outbox_lag_seconds_sum');
    expect(sum?.value).toBe(2.5);
  });

  it('observes nothing when the publication fails', async () => {
    const metrics = new WageringMetrics();
    const failing: IMessagePublisher = { publish: () => Promise.reject(new Error('sqs down')) };
    const publisher = new ObservedMessagePublisher(failing, metrics, new FakeClock(new Date()));

    await expect(publisher.publish(message(new Date()))).rejects.toThrow('sqs down');

    expect(await metricValue(metrics, 'outbox_lag_seconds')).toBe(0);
  });
});
