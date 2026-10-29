import { type EntityManager, IsolationLevel } from '@mikro-orm/postgresql';
import type { IUnitOfWork, UnitOfWorkOptions as RunOptions } from '../../../business/shared/port/unit-of-work.port';
import { FaultInjector } from '../../fault-injection/fault-injector';
import { translateDatabaseError } from '../database-error';

export type TxRepositoriesFactory<TTx> = (em: EntityManager) => TTx;

export interface UnitOfWorkOptions {
  readonly lockTimeoutMs: number;
  readonly faults?: FaultInjector;
}

/**
 * One transaction per `run`, on a fresh fork so nothing leaks between units. Every repository handed to `work`
 * is bound to the transactional EntityManager, so all writes commit or roll back together.
 * `read-write` (default) is READ COMMITTED with row locks; `snapshot-read` is REPEATABLE READ READ ONLY, one
 * consistent snapshot for reconciliation. lock_timeout is SET LOCAL: it dies with the transaction and never
 * touches pooled sessions. `crash_before_commit` fails the unit after `work` finished, right before COMMIT.
 */
export class MikroOrmUnitOfWork<TTx> implements IUnitOfWork<TTx> {
  private readonly faults: FaultInjector;

  constructor(
    private readonly em: EntityManager,
    private readonly createRepositories: TxRepositoriesFactory<TTx>,
    private readonly options: UnitOfWorkOptions,
  ) {
    this.faults = options.faults ?? FaultInjector.none();
  }

  async run<T>(work: (tx: TTx) => Promise<T>, { mode = 'read-write' }: RunOptions = {}): Promise<T> {
    const snapshot = mode === 'snapshot-read';
    try {
      return await this.em.fork().transactional(
        async (txEm) => {
          await txEm.execute("SELECT set_config('lock_timeout', ?, true)", [`${this.options.lockTimeoutMs}ms`]);
          const result = await work(this.createRepositories(txEm));
          this.faults.trip('crash_before_commit');
          return result;
        },
        snapshot
          ? { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true }
          : { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
