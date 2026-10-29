import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { InboxMessage } from '../../../src/business/messaging/entity/inbox-message';
import { OutboxMessage } from '../../../src/business/messaging/entity/outbox-message';
import { PermanentInfrastructureError } from '../../../src/infrastructure/error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../../../src/infrastructure/error/transient-infrastructure-error';
import { FaultInjector, InjectedFaultError } from '../../../src/infrastructure/fault-injection/fault-injector';
import {
  createMessagingRepositories,
  type MessagingRepositories,
} from '../../../src/infrastructure/persistence/mikro-orm/repository/messaging-repositories';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm/unit-of-work';
import { aFakeEvent } from '../../support/fakes/fake-integration-event';
import { uuidv7 } from '../../support/uuid';
import { messagingTables, type OrmDatabase } from './messaging-orm';

type Tx = MessagingRepositories & { readonly em: EntityManager };

const t0 = new Date('2026-07-29T15:00:00.000Z');

const anInbox = () =>
  InboxMessage.create({ consumerName: 'wager-transactions', messageId: uuidv7(), payloadHash: 'hash', receivedAt: t0 });
const anOutbox = () =>
  OutboxMessage.fromEvent(aFakeEvent({ eventId: uuidv7(), aggregateId: uuidv7(), occurredAt: t0 }));

describe('MikroOrmUnitOfWork', () => {
  const tables = messagingTables();
  let db: OrmDatabase;

  const unitOfWork = (lockTimeoutMs = 2_000, faults = FaultInjector.none()) =>
    new MikroOrmUnitOfWork<Tx>(db.orm.em, (em) => ({ em, ...createMessagingRepositories(em, faults) }), {
      lockTimeoutMs,
    });

  const count = async (table: string): Promise<number> => {
    const [row] = await db.orm.em.fork().execute<{ total: number }[]>(`SELECT count(*)::int AS total FROM ${table}`);
    return row!.total;
  };

  const rejection = (work: Promise<unknown>): Promise<unknown> =>
    work.then(
      () => {
        throw new Error('expected the unit of work to fail');
      },
      (error: unknown) => error,
    );

  beforeEach(async () => {
    db = await tables.fresh();
  });

  afterAll(() => tables.close());

  it('runs in READ COMMITTED with a transaction-local lock_timeout', async () => {
    const settings = await unitOfWork(1_500).run(async ({ em }) => {
      const [row] = await em.execute<{ isolation: string; lock_timeout: string }[]>(
        "SELECT current_setting('transaction_isolation') AS isolation, current_setting('lock_timeout') AS lock_timeout",
      );
      return row!;
    });

    expect(settings).toEqual({ isolation: 'read committed', lock_timeout: '1500ms' });
  });

  it('leaves the pooled connection with the server lock_timeout once the unit ends', async () => {
    const single = await MikroORM.init(createMikroOrmConfig(db.database.url, { max: 1 }));
    const session = async (em: EntityManager) => {
      const [row] = await em.execute<{ pid: number; lock_timeout: string }[]>(
        "SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock_timeout",
      );
      return row!;
    };
    try {
      const outside = await session(single.em.fork());
      const inside = await new MikroOrmUnitOfWork<Tx>(single.em, (em) => ({ em, ...createMessagingRepositories(em) }), {
        lockTimeoutMs: 1_500,
      }).run(({ em }) => session(em));
      const after = await session(single.em.fork());

      expect(inside).toEqual({ pid: outside.pid, lock_timeout: '1500ms' });
      expect(after).toEqual(outside);
    } finally {
      await single.close(true);
    }
  });

  it('commits inbox and outbox together', async () => {
    await unitOfWork().run(async ({ inbox, outbox }) => {
      await inbox.insertIfAbsent(anInbox());
      await outbox.add([anOutbox(), anOutbox()]);
    });

    expect(await count('inbox_messages')).toBe(1);
    expect(await count('outbox_messages')).toBe(2);
  });

  it('rolls back inbox and outbox when the work throws, rethrowing the original error', async () => {
    const failure = new Error('business failure after writing');

    const error = await rejection(
      unitOfWork().run(async ({ inbox, outbox }) => {
        await inbox.insertIfAbsent(anInbox());
        await outbox.add([anOutbox()]);
        throw failure;
      }),
    );

    expect(error).toBe(failure);
    expect(await count('inbox_messages')).toBe(0);
    expect(await count('outbox_messages')).toBe(0);
  });

  it('rolls back the inbox when fail_outbox_insert is injected', async () => {
    const faults = FaultInjector.fromEnv({ FAULT_INJECTION: 'fail_outbox_insert' });

    const error = await rejection(
      unitOfWork(2_000, faults).run(async ({ inbox, outbox }) => {
        await inbox.insertIfAbsent(anInbox());
        await outbox.add([anOutbox()]);
      }),
    );

    expect(error).toBeInstanceOf(InjectedFaultError);
    expect(await count('inbox_messages')).toBe(0);
    expect(await count('outbox_messages')).toBe(0);
  });

  it('turns a lock timeout (55P03) into a TransientInfrastructureError', async () => {
    const message = anOutbox();
    await createMessagingRepositories(db.orm.em.fork()).outbox.add([message]);
    const holder = new Client({ connectionString: db.database.url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM outbox_messages WHERE event_id = $1 FOR UPDATE', [message.id]);

      const error = await rejection(
        unitOfWork(200).run(({ em }) =>
          em.execute('SELECT 1 FROM outbox_messages WHERE event_id = ? FOR UPDATE', [message.id]),
        ),
      );

      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as TransientInfrastructureError).sqlState).toBe('55P03');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('turns a deadlock (40P01) into a TransientInfrastructureError and lets the survivor commit', async () => {
    const [first, second] = [anOutbox(), anOutbox()];
    await createMessagingRepositories(db.orm.em.fork()).outbox.add([first, second]);
    const lock = (em: EntityManager, id: string) =>
      em.execute('SELECT 1 FROM outbox_messages WHERE event_id = ? FOR UPDATE', [id]);

    let markA: () => void = () => undefined;
    let markB: () => void = () => undefined;
    const aLocked = new Promise<void>((resolve) => (markA = resolve));
    const bLocked = new Promise<void>((resolve) => (markB = resolve));
    const crossing = (own: string, other: string, mark: () => void, peer: Promise<void>) =>
      unitOfWork(10_000).run(async ({ em }) => {
        await lock(em, own);
        mark();
        await peer;
        await lock(em, other);
        return 'committed';
      });

    const outcomes = await Promise.allSettled([
      crossing(first.id, second.id, markA, bLocked),
      crossing(second.id, first.id, markB, aLocked),
    ]);

    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failures).toHaveLength(1);
    const reason = (failures[0] as PromiseRejectedResult).reason as TransientInfrastructureError;
    expect(reason).toBeInstanceOf(TransientInfrastructureError);
    expect(reason.sqlState).toBe('40P01');
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
  });

  it('turns an immutability trigger (23001) into a PermanentInfrastructureError', async () => {
    const walletId = uuidv7();
    await db.orm.em
      .fork()
      .execute(`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
                VALUES (?, ?, 'BRL', 0, 1, ?, ?)`, [walletId, uuidv7(), t0, t0]);

    const error = await rejection(
      unitOfWork().run(({ em }) => em.execute('DELETE FROM wallets WHERE id = ?', [walletId])),
    );

    expect(error).toBeInstanceOf(PermanentInfrastructureError);
    expect((error as PermanentInfrastructureError).sqlState).toBe('23001');
  });
});
