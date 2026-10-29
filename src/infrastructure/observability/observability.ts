import type { DestinationStream } from 'pino';
import { WorkerObservers } from './hooks/worker-observers';
import { createLogger, type Logger } from './logging/logger';
import { WageringMetrics } from './metrics/wagering-metrics';

export interface Observability {
  readonly logger: Logger;
  readonly metrics: WageringMetrics;
  readonly workers: WorkerObservers;
}

export interface ObservabilityOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Overrides LOG_LEVEL (the e2e suites pass `silent`). */
  readonly level?: string;
  /** Where the JSON lines go; stdout by default. */
  readonly destination?: DestinationStream;
}

/** One logger and one metrics registry per process (or per app, in the e2e suites). */
export const createObservability = ({ env = process.env, level, destination }: ObservabilityOptions = {}): Observability => {
  const logger = createLogger({
    level: level ?? env.LOG_LEVEL ?? 'info',
    ...(destination === undefined ? {} : { destination }),
  });
  const metrics = new WageringMetrics();
  return { logger, metrics, workers: new WorkerObservers(metrics, logger) };
};
