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

export class DisposeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`A resource did not dispose within ${timeoutMs}ms`);
    this.name = 'DisposeTimeoutError';
  }
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 30_000;

const withTimeout = async (work: Promise<unknown>, timeoutMs: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DisposeTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Disposes tracked resources one at a time, newest first (a queue before the database it may depend on),
 * each bounded by `disposeTimeoutMs`; a failure or a timeout is collected and the next resource still runs.
 */
export class ResourceScope {
  private readonly disposers: Array<() => Promise<unknown>> = [];

  constructor(private readonly disposeTimeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS) {}

  track<T>(resource: Promise<T>, dispose: (value: T) => Promise<unknown>): Promise<T> {
    this.disposers.push(async () => {
      const settled = await Promise.allSettled([resource]);
      const [outcome] = settled;
      if (outcome?.status === 'fulfilled') await dispose(outcome.value);
    });
    return resource;
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = [];
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        await withTimeout(dispose(), this.disposeTimeoutMs);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} resources failed to dispose`);
  }
}
