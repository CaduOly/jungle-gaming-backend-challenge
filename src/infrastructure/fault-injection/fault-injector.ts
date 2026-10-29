import { readIntegerEnv } from '../config/integer-env';

export const FAULT_POINTS = [
  'fail_outbox_insert',
  'fail_ledger_insert',
  'crash_before_commit',
  'crash_after_publish_before_mark',
  'crash_after_commit_before_ack',
  'slow_handler',
] as const;

export const DEFAULT_SLOW_HANDLER_MS = 2_000;

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
  private constructor(
    private readonly active: ReadonlySet<FaultPoint>,
    /** How long `slow_handler` holds a message (FAULT_SLOW_HANDLER_MS). */
    readonly slowHandlerMs: number = DEFAULT_SLOW_HANDLER_MS,
  ) {}

  static none(): FaultInjector {
    return new FaultInjector(new Set());
  }

  static of(...points: FaultPoint[]): FaultInjector {
    return new FaultInjector(new Set(points));
  }

  withSlowHandlerMs(ms: number): FaultInjector {
    return new FaultInjector(this.active, ms);
  }

  static fromEnv(env: Readonly<Record<string, string | undefined>>): FaultInjector {
    const raw = env.FAULT_INJECTION?.trim() ?? '';
    if (raw === '') return FaultInjector.none();
    const points = raw.split(',').map((point) => point.trim());
    const unknown = points.filter((point) => !isFaultPoint(point));
    if (unknown.length > 0) {
      throw new Error(`Unknown FAULT_INJECTION point(s): ${unknown.join(', ')}. Known: ${FAULT_POINTS.join(', ')}`);
    }
    const slowHandlerMs = readIntegerEnv(env, 'FAULT_SLOW_HANDLER_MS', DEFAULT_SLOW_HANDLER_MS);
    return new FaultInjector(new Set(points.filter(isFaultPoint)), slowHandlerMs);
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
