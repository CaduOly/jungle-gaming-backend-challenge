export interface UnitOfWorkOptions {
  /**
   * `read-write` (padrão): READ COMMITTED com row lock. `snapshot-read`: só leitura, um snapshot
   * consistente (REPEATABLE READ), usado pela reconciliação.
   */
  readonly mode?: 'read-write' | 'snapshot-read';
}

/**
 * Roda `work` dentro de uma transação do banco: faz commit quando resolve, rollback quando lança erro,
 * e libera todos os row locks nos dois casos. Nada escrito via `tx` fica visível para outra conexão antes
 * do commit.
 */
export interface IUnitOfWork<TTx> {
  run<T>(work: (tx: TTx) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
