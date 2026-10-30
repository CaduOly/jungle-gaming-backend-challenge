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
 * Uma transação por `run`, num fork novo para nada vazar entre units. Todo repository passado para `work` está
 * ligado ao EntityManager transacional, então todas as escritas commitam ou fazem rollback juntas.
 * `read-write` (default) é READ COMMITTED com row lock; `snapshot-read` é REPEATABLE READ READ ONLY, um snapshot
 * consistente para a reconciliação. O lock_timeout é SET LOCAL, morre com a transação e nunca mexe nas sessões do
 * pool. `crash_before_commit` falha a unit depois que o `work` terminou, logo antes do COMMIT.
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
