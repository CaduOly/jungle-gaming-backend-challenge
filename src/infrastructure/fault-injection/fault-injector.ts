export const FAULT_POINTS = ['fail_outbox_insert', 'crash_after_publish_before_mark'] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export class InjectedFaultError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`Injected fault: ${point}`);
    this.name = 'InjectedFaultError';
  }
}

const killSelf = (): void => {
  process.kill(process.pid, 'SIGKILL');
};

const isFaultPoint = (value: string): value is FaultPoint => (FAULT_POINTS as readonly string[]).includes(value);

/** Test-only failure points, enabled exclusively through FAULT_INJECTION=point[,point]. */
export class FaultInjector {
  private constructor(private readonly active: ReadonlySet<FaultPoint>) {}

  static none(): FaultInjector {
    return new FaultInjector(new Set());
  }

  static of(...points: FaultPoint[]): FaultInjector {
    return new FaultInjector(new Set(points));
  }

  static fromEnv(env: Readonly<Record<string, string | undefined>>): FaultInjector {
    const raw = env.FAULT_INJECTION?.trim() ?? '';
    if (raw === '') return FaultInjector.none();
    const points = raw.split(',').map((point) => point.trim());
    const unknown = points.filter((point) => !isFaultPoint(point));
    if (unknown.length > 0) {
      throw new Error(`Unknown FAULT_INJECTION point(s): ${unknown.join(', ')}. Known: ${FAULT_POINTS.join(', ')}`);
    }
    return new FaultInjector(new Set(points.filter(isFaultPoint)));
  }

  isActive(point: FaultPoint): boolean {
    return this.active.has(point);
  }

  trip(point: FaultPoint): void {
    if (this.isActive(point)) throw new InjectedFaultError(point);
  }

  /** Kills the process without any cleanup, the way a crash or `kill -9` would. */
  crash(point: FaultPoint, kill: () => void = killSelf): void {
    if (this.isActive(point)) kill();
  }
}
