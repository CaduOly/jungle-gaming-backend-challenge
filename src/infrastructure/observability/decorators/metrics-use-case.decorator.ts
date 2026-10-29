import type { IUseCase } from '../../../business/shared/use-case';
import { classifyError } from '../metrics/error-classification';
import type { WageringMetrics } from '../metrics/wagering-metrics';

export interface UseCaseMetricsOptions<Output> {
  /** Snake-case name of the use case, the `operation` label of processing_duration_seconds. */
  readonly operation: string;
  /** The `outcome` label of a successful run; `ok` when omitted. */
  readonly outcomeOf?: (output: Output) => string;
  /** Feeds the metrics only this use case's output can tell (status, replay, divergence). */
  readonly record?: (output: Output, metrics: WageringMetrics) => void;
}

/**
 * Times the use case and labels the run with its outcome: the one the output tells, or the class of the error
 * thrown (lock_timeout, deadlock, transient, business_rule…). Nothing here can change what the use case returns
 * or throws: a failing recorder is swallowed.
 */
export class MetricsUseCaseDecorator<Input, Output> implements IUseCase<Input, Output> {
  constructor(
    private readonly inner: IUseCase<Input, Output>,
    private readonly metrics: WageringMetrics,
    private readonly options: UseCaseMetricsOptions<Output>,
  ) {}

  async execute(input: Input): Promise<Output> {
    const stopTimer = this.metrics.processingDuration.startTimer({ operation: this.options.operation });
    let output: Output;
    try {
      output = await this.inner.execute(input);
    } catch (error) {
      stopTimer({ outcome: classifyError(error) });
      throw error;
    }
    try {
      stopTimer({ outcome: this.options.outcomeOf?.(output) ?? 'ok' });
      this.options.record?.(output, this.metrics);
    } catch {
      // A metric must never turn a decided transaction into an error.
    }
    return output;
  }
}
