import type { IUseCase } from '../../../business/shared/use-case';
import type { Logger } from '../logging/logger';
import type { WageringMetrics } from '../metrics/wagering-metrics';
import { LoggingUseCaseDecorator, type UseCaseLoggingOptions } from './logging-use-case.decorator';
import { MetricsUseCaseDecorator, type UseCaseMetricsOptions } from './metrics-use-case.decorator';

export interface UseCaseObservation<Input, Output>
  extends UseCaseLoggingOptions<Input, Output>,
    UseCaseMetricsOptions<Output> {}

export interface ObservabilityTools {
  readonly logger: Logger;
  readonly metrics: WageringMetrics;
}

/** Logging por fora, métricas por dentro, então a duração na linha de log inclui o tempo que as métricas levaram. */
export const observeUseCase = <Input, Output>(
  inner: IUseCase<Input, Output>,
  tools: ObservabilityTools,
  observation: UseCaseObservation<Input, Output>,
): IUseCase<Input, Output> =>
  new LoggingUseCaseDecorator(new MetricsUseCaseDecorator(inner, tools.metrics, observation), tools.logger, observation);
