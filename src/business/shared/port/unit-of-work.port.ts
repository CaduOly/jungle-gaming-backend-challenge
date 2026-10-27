export interface IUnitOfWork<TTx> {
  run<T>(work: (tx: TTx) => Promise<T>): Promise<T>;
}
