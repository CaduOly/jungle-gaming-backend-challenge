import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { ExponentialBackoff } from '../../../src/business/shared/policy/exponential-backoff';
import type { IWageringUnitOfWork, TxRepositories } from '../../../src/business/wagering/port/tx-repositories.port';
import { GetWagerTransaction } from '../../../src/business/wagering/use-case/get-wager-transaction/get-wager-transaction';
import { ProcessWagerTransaction } from '../../../src/business/wagering/use-case/process-wager-transaction/process-wager-transaction';
import { RetryPendingReferences } from '../../../src/business/wagering/use-case/retry-pending-references/retry-pending-references';
import { CreateWallet } from '../../../src/business/wallet/use-case/create-wallet/create-wallet';
import { GetLedger } from '../../../src/business/wallet/use-case/get-ledger/get-ledger';
import { GetWallet } from '../../../src/business/wallet/use-case/get-wallet/get-wallet';
import { ReconcileWallet } from '../../../src/business/wallet/use-case/reconcile-wallet/reconcile-wallet';
import { FaultInjector } from '../../../src/infrastructure/fault-injection/fault-injector';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';
import { migrateUp } from '../../../src/infrastructure/persistence/mikro-orm/migrator';
import {
  createReadRepositories,
  createTxRepositories,
} from '../../../src/infrastructure/persistence/mikro-orm/repository/wagering-repositories';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm/unit-of-work';
import { assertWalletConsistency } from '../../support/assert-wallet-consistency';
import { ensureInfraUp } from '../../support/ensure-infra-up';
import { FakeClock } from '../../support/fakes/fake-clock';
import { FakePayloadHasher } from '../../support/fakes/fake-payload-hasher';
import { UuidIdGenerator } from '../../support/fakes/uuid-id-generator';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

export interface WageringDatabase {
  readonly database: TestDatabase;
  readonly orm: MikroORM;
  /** Conexão crua para as verificações: contagens, consistência e segurar lock de fora da aplicação. */
  readonly sql: Client;
  /** Um ORM extra com pool próprio, para o trabalho concorrente rodar em conexões separadas de verdade. */
  connect(): Promise<MikroORM>;
  assertConsistent(walletIds: Iterable<string>): Promise<void>;
  close(): Promise<void>;
}

export const createWageringDatabase = async (): Promise<WageringDatabase> => {
  await ensureInfraUp();
  const database = await createTestDatabase();
  await migrateUp(database.url);
  const orm = await MikroORM.init(createMikroOrmConfig(database.url));
  const sql = new Client({ connectionString: database.url });
  await sql.connect();
  const extra: MikroORM[] = [];
  return {
    database,
    orm,
    sql,
    connect: async () => {
      const another = await MikroORM.init(createMikroOrmConfig(database.url));
      extra.push(another);
      return another;
    },
    assertConsistent: async (walletIds) => {
      for (const walletId of walletIds) await assertWalletConsistency(sql, walletId);
    },
    close: async () => {
      await sql.end();
      await Promise.all([orm, ...extra].map((instance) => instance.close(true)));
      await database.drop();
    },
  };
};

export interface RealAppOptions {
  readonly clock?: FakeClock;
  readonly faults?: FaultInjector;
  readonly lockTimeoutMs?: number;
  readonly maxAttempts?: number;
}

/** Todos os use cases em cima da unit of work e dos repositórios reais; só clock, ids e hasher são dublês. */
export const createRealWageringApp = (orm: MikroORM, options: RealAppOptions = {}) => {
  const clock = options.clock ?? new FakeClock();
  const faults = options.faults ?? FaultInjector.none();
  const uow: IWageringUnitOfWork = new MikroOrmUnitOfWork<TxRepositories>(
    orm.em,
    (em) => createTxRepositories(em, { clock, faults }),
    { lockTimeoutMs: options.lockTimeoutMs ?? 2_000, faults },
  );
  const ids = new UuidIdGenerator();
  const hasher = new FakePayloadHasher();
  const backoff = new ExponentialBackoff({
    baseMs: 2_000,
    capMs: 60_000,
    maxAttempts: options.maxAttempts ?? 4,
    random: () => 0,
  });
  const readers = createReadRepositories(orm.em, clock);
  return {
    uow,
    clock,
    process: new ProcessWagerTransaction(uow, hasher, clock, ids, backoff),
    retry: new RetryPendingReferences(uow, clock, ids, backoff, { batchSize: 50, leaseMs: 30_000 }),
    createWallet: new CreateWallet(uow, hasher, clock, ids),
    getWallet: new GetWallet(readers.wallets),
    getLedger: new GetLedger(readers.wallets, readers.ledger),
    getTransaction: new GetWagerTransaction(readers.wagers),
    reconcile: new ReconcileWallet(uow),
  };
};

export type RealWageringApp = ReturnType<typeof createRealWageringApp>;

export const countRows = async (sql: Client, table: string, where = 'TRUE', params: unknown[] = []): Promise<number> => {
  const { rows } = await sql.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${table} WHERE ${where}`, params);
  return rows[0]!.total;
};
