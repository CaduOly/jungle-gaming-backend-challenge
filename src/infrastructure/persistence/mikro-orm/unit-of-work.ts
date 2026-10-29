import { type EntityManager, IsolationLevel } from '@mikro-orm/postgresql';
import type { IUnitOfWork } from '../../../business/shared/port/unit-of-work.port';
import { translateDatabaseError } from '../database-error';

export type TxRepositoriesFactory<TTx> = (em: EntityManager) => TTx;

export interface UnitOfWorkOptions {
  readonly lockTimeoutMs: number;
}

/**
 * One READ COMMITTED transaction per `run`, on a fresh fork so nothing leaks between units. Every
 * repository handed to `work` is bound to the transactional EntityManager, so all writes commit or roll
 * back together. lock_timeout is SET LOCAL: it dies with the transaction and never touches pooled sessions.
 */
export class MikroOrmUnitOfWork<TTx> implements IUnitOfWork<TTx> {
  constructor(
    private readonly em: EntityManager,
    private readonly createRepositories: TxRepositoriesFactory<TTx>,
    private readonly options: UnitOfWorkOptions,
  ) {}

  async run<T>(work: (tx: TTx) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional(
        async (txEm) => {
          await txEm.execute("SELECT set_config('lock_timeout', ?, true)", [`${this.options.lockTimeoutMs}ms`]);
          return work(this.createRepositories(txEm));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
