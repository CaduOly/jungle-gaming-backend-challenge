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
  /** Sobrescreve o LOG_LEVEL (as suites e2e passam `silent`). */
  readonly level?: string;
  /** Para onde vão as linhas JSON, stdout por default. */
  readonly destination?: DestinationStream;
}

/** Um logger e um registry de métricas por processo (ou por app, nas suites e2e). */
export const createObservability = ({ env = process.env, level, destination }: ObservabilityOptions = {}): Observability => {
  const logger = createLogger({
    level: level ?? env.LOG_LEVEL ?? 'info',
    ...(destination === undefined ? {} : { destination }),
  });
  const metrics = new WageringMetrics();
  return { logger, metrics, workers: new WorkerObservers(metrics, logger) };
};
