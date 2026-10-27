import { afterAll } from 'bun:test';
import { InboxRepository } from '../../../src/infrastructure/persistence/mikro-orm/repository/inbox.repository';
import { OutboxRepository } from '../../../src/infrastructure/persistence/mikro-orm/repository/outbox.repository';
import { describeInboxRepositoryContract } from '../../support/contracts/inbox-repository.contract';
import { describeOutboxRepositoryContract } from '../../support/contracts/outbox-repository.contract';
import { messagingTables } from './messaging-orm';

const tables = messagingTables();

afterAll(() => tables.close());

describeInboxRepositoryContract('PostgreSQL', async () => {
  const { orm } = await tables.fresh();
  return { repository: new InboxRepository(orm.em.fork()) };
});

describeOutboxRepositoryContract('PostgreSQL', async () => {
  const { orm } = await tables.fresh();
  return { repository: new OutboxRepository(orm.em.fork()) };
});
