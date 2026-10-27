import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../../src/infrastructure/error/transient-infrastructure-error';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm/unit-of-work';
import { createOrmDatabase, type OrmDatabase } from './messaging-orm';

const POOL_MAX = 2;
const KILLS = POOL_MAX * 3;

const within = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} hung for ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, hang]);
  } finally {
    clearTimeout(timer);
  }
};

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => {
      throw new Error('expected the unit of work to fail');
    },
    (error: unknown) => error,
  );

describe('connection pool resilience', () => {
  let db: OrmDatabase;
  let killer: MikroORM;

  const smallPool = (acquireTimeoutMs = 1_000) =>
    MikroORM.init(createMikroOrmConfig(db.database.url, { max: POOL_MAX, acquireTimeoutMs }));

  const unitOfWork = (orm: MikroORM) =>
    new MikroOrmUnitOfWork<{ em: EntityManager }>(orm.em, (em) => ({ em }), { lockTimeoutMs: 1_000 });

  const backendPid = async (em: EntityManager): Promise<number> => {
    const [row] = await em.execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    return row!.pid;
  };

  const terminate = (pid: number) => killer.em.fork().execute('SELECT pg_terminate_backend(?)', [pid]);

  beforeAll(async () => {
    db = await createOrmDatabase();
    killer = await db.connect();
  });

  afterAll(() => db?.close());

  it(`stays usable after ${KILLS} backends die inside a unit of work (pool max ${POOL_MAX})`, async () => {
    const orm = await smallPool();
    const uow = unitOfWork(orm);
    try {
      for (let kill = 1; kill <= KILLS; kill++) {
        const killedIdle = kill % 2 === 0;
        const error = await within(
          failureOf(
            uow.run(async ({ em }) => {
              const pid = await backendPid(em);
              if (killedIdle) {
                await terminate(pid);
                await em.execute('SELECT 1');
              } else {
                await Promise.all([em.execute('SELECT pg_sleep(5)'), Bun.sleep(100).then(() => terminate(pid))]);
              }
            }),
          ),
          5_000,
          `unit of work after kill ${kill}`,
        );
        expect(error).toBeInstanceOf(TransientInfrastructureError);

        const healthy = await within(
          uow.run(async ({ em }) => (await em.execute<{ one: number }[]>('SELECT 1 AS one'))[0]?.one),
          5_000,
          `healthy unit of work after kill ${kill}`,
        );
        expect(healthy).toBe(1);
      }
    } finally {
      await within(orm.close(true), 5_000, 'pool shutdown');
    }
  });

  it('turns an exhausted pool into a transient error instead of hanging', async () => {
    const orm = await smallPool(300);
    const uow = unitOfWork(orm);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const holders = Array.from({ length: POOL_MAX }, () => uow.run(() => held));
      await Bun.sleep(100);
      const error = await within(failureOf(uow.run(async () => undefined)), 3_000, 'acquire');
      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as Error).message).toContain('timeout exceeded when trying to connect');
      release();
      await Promise.all(holders);
      expect(await uow.run(async () => 'ok')).toBe('ok');
    } finally {
      release();
      await within(orm.close(true), 5_000, 'pool shutdown');
    }
  });
});
