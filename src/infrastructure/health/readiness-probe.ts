import type { IReadinessCheck } from './readiness-check.port';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly status: 'ready' | 'unavailable';
  readonly checks: Readonly<Record<string, DependencyStatus>>;
}

class ReadinessTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`${name} did not answer within ${timeoutMs}ms`);
    this.name = 'ReadinessTimeoutError';
  }
}

export const withTimeout = async (check: IReadinessCheck, timeoutMs: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadinessTimeoutError(check.name, timeoutMs)), timeoutMs);
  });
  try {
    await Promise.race([check.check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Runs every check in parallel, each bounded by the timeout, so a hung dependency answers "down" in time for the
 * probe instead of hanging it. Ready only when all are up; with no checks at all it is ready.
 */
export class ReadinessProbe {
  constructor(
    private readonly checks: readonly IReadinessCheck[],
    private readonly timeoutMs: number,
  ) {}

  async run(): Promise<ReadinessReport> {
    const results = await Promise.allSettled(this.checks.map((check) => withTimeout(check, this.timeoutMs)));
    const checks = Object.fromEntries(
      this.checks.map((check, index): [string, DependencyStatus] => [check.name, results[index]?.status === 'fulfilled' ? 'up' : 'down']),
    );
    return { status: Object.values(checks).every((status) => status === 'up') ? 'ready' : 'unavailable', checks };
  }
}
