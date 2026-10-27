import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from './mikro-orm.config';

export type MigrationDirection = 'up' | 'down';

export interface MigrationRun {
  readonly direction: MigrationDirection;
  readonly applied: readonly string[];
}

const withOrm = async <T>(databaseUrl: string, work: (orm: MikroORM) => Promise<T>): Promise<T> => {
  const orm = await MikroORM.init(createMikroOrmConfig(databaseUrl));
  try {
    return await work(orm);
  } finally {
    await orm.close(true);
  }
};

export const migrateUp = (databaseUrl: string): Promise<MigrationRun> =>
  withOrm(databaseUrl, async (orm) => {
    const applied = await orm.migrator.up();
    return { direction: 'up', applied: applied.map((migration) => migration.name) };
  });

/** Reverts the last migration, or every migration when `all` is set. */
export const migrateDown = (databaseUrl: string, options: { all?: boolean } = {}): Promise<MigrationRun> =>
  withOrm(databaseUrl, async (orm) => {
    const reverted = await orm.migrator.down(options.all ? { to: 0 } : undefined);
    return { direction: 'down', applied: reverted.map((migration) => migration.name) };
  });
