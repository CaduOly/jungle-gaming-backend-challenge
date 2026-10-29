export interface UnitOfWorkOptions {
  /**
   * `read-write` (default): READ COMMITTED with row locks. `snapshot-read`: read-only, one consistent
   * snapshot (REPEATABLE READ), used by reconciliation.
   */
  readonly mode?: 'read-write' | 'snapshot-read';
}

/**
 * Runs `work` inside one database transaction: commits when it resolves, rolls back when it throws,
 * and releases every row lock either way. Nothing written through `tx` is visible to anyone else before
 * the commit.
 */
export interface IUnitOfWork<TTx> {
  run<T>(work: (tx: TTx) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
