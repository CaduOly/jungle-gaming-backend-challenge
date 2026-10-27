const failuresOf = (results: readonly PromiseSettledResult<unknown>[]): unknown[] =>
  results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));

export const settleAllOrThrow = async <const T extends readonly unknown[]>(promises: {
  readonly [K in keyof T]: Promise<T[K]>;
}): Promise<T> => {
  const results = await Promise.allSettled(promises);
  const failures = failuresOf(results);
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} of ${results.length} operations failed`);
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
};

export class ResourceScope {
  private readonly disposers: Array<() => Promise<unknown>> = [];

  async track<T>(resource: Promise<T>, dispose: (value: T) => Promise<unknown>): Promise<T> {
    const value = await resource;
    this.disposers.push(() => dispose(value));
    return value;
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled(this.disposers.splice(0).reverse().map((dispose) => dispose()));
    const failures = failuresOf(results);
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} resources failed to dispose`);
  }
}
