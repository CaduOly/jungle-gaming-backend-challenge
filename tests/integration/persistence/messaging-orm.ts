import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';
import { migrateUp } from '../../../src/infrastructure/persistence/mikro-orm/migrator';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

export interface OrmDatabase {
  readonly database: TestDatabase;
  readonly orm: MikroORM;
  /** Um ORM extra com pool próprio, para rodar trabalho em conexões separadas de verdade. */
  connect(): Promise<MikroORM>;
  close(): Promise<void>;
}

export const createOrmDatabase = async (): Promise<OrmDatabase> => {
  await ensureInfraUp();
  const database = await createTestDatabase();
  await migrateUp(database.url);
  const extra: MikroORM[] = [];
  const orm = await MikroORM.init(createMikroOrmConfig(database.url));
  return {
    database,
    orm,
    connect: async () => {
      const another = await MikroORM.init(createMikroOrmConfig(database.url));
      extra.push(another);
      return another;
    },
    close: async () => {
      await Promise.all([orm, ...extra].map((instance) => instance.close(true)));
      await database.drop();
    },
  };
};

/** Cria sob demanda um banco migrado por suíte e esvazia as tabelas de messaging antes de cada teste. */
export const messagingTables = () => {
  let current: Promise<OrmDatabase> | undefined;
  return {
    fresh: async (): Promise<OrmDatabase> => {
      current ??= createOrmDatabase();
      const db = await current;
      await db.orm.em.fork().execute('DELETE FROM outbox_messages; DELETE FROM inbox_messages;');
      return db;
    },
    close: async (): Promise<void> => {
      if (current) await (await current).close();
    },
  };
};
