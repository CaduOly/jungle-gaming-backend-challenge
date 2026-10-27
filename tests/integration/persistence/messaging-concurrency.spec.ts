import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../../src/business/messaging/entity/inbox-message';
import { OutboxMessage } from '../../../src/business/messaging/entity/outbox-message';
import { InboxRepository } from '../../../src/infrastructure/persistence/mikro-orm/repository/inbox.repository';
import { OutboxRepository } from '../../../src/infrastructure/persistence/mikro-orm/repository/outbox.repository';
import { aFakeEvent } from '../../support/fakes/fake-integration-event';
import { uuidv7 } from '../../support/uuid';
import { createOrmDatabase, type OrmDatabase } from './messaging-orm';

const CLAIMERS = 6;
const t0 = new Date('2026-07-29T15:00:00.000Z');

describe('messaging repositories under real concurrency (separate connection pools)', () => {
  let db: OrmDatabase;
  let orms: MikroORM[];

  beforeAll(async () => {
    db = await createOrmDatabase();
    orms = await Promise.all(Array.from({ length: CLAIMERS }, () => db.connect()));
  });

  afterAll(() => db?.close());

  it('never hands the same outbox row to two concurrent claimers', async () => {
    const messages = Array.from({ length: 300 }, (_, index) =>
      OutboxMessage.fromEvent(
        aFakeEvent({ eventId: uuidv7(), aggregateId: uuidv7(), occurredAt: new Date(t0.getTime() + (index % 17)) }),
      ),
    );
    await new OutboxRepository(db.orm.em.fork()).add(messages);

    const drain = async (orm: MikroORM): Promise<string[]> => {
      const repository = new OutboxRepository(orm.em.fork());
      const claimed: string[] = [];
      for (;;) {
        const batch = await repository.claimBatch(7, 60_000, new Date(t0.getTime() + 1_000));
        if (batch.length === 0) return claimed;
        claimed.push(...batch.map((message) => message.id));
      }
    };

    const perClaimer = await Promise.all(orms.map(drain));
    const all = perClaimer.flat();

    expect(all).toHaveLength(messages.length);
    expect(new Set(all).size).toBe(messages.length);
    expect(perClaimer.filter((ids) => ids.length > 0).length).toBeGreaterThan(1);
  });

  it('lets exactly one of many concurrent inbox inserts win', async () => {
    const messageId = uuidv7();
    const message = () =>
      InboxMessage.create({ consumerName: 'wager-transactions', messageId, payloadHash: 'hash-a', receivedAt: t0 });

    const results = await Promise.all(orms.map((orm) => new InboxRepository(orm.em.fork()).insertIfAbsent(message())));

    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    for (const result of results) {
      if (!result.inserted) expect(result.existing.payloadHash).toBe('hash-a');
    }
  });
});
