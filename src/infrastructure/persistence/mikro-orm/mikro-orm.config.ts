import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { DEFAULT_POOL_ACQUIRE_TIMEOUT_MS } from '../../config/database-config';
import { migrationsList } from './migration';
import { guardPool } from './pool-guard';

export interface MikroOrmPoolOptions {
  /** Quanto tempo um acquire espera conexão livre antes de falhar (transiente), em vez de travar. */
  readonly acquireTimeoutMs?: number;
  readonly max?: number;
}

export const createMikroOrmConfig = (clientUrl: string, pool: MikroOrmPoolOptions = {}): Options =>
  defineConfig({
    clientUrl,
    ...(pool.max === undefined ? {} : { pool: { min: 0, max: pool.max } }),
    driverOptions: {
      connectionTimeoutMillis: pool.acquireTimeoutMs ?? DEFAULT_POOL_ACQUIRE_TIMEOUT_MS,
      onPoolCreated: guardPool,
    },
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
  });
