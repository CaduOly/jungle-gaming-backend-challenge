import type { IUseCase } from '../../../business/shared/use-case';
import { classifyError } from '../metrics/error-classification';
import type { WageringMetrics } from '../metrics/wagering-metrics';

export interface UseCaseMetricsOptions<Output> {
  /** Nome do use case em snake-case, é o label `operation` do processing_duration_seconds. */
  readonly operation: string;
  /** O label `outcome` de uma execução com sucesso, `ok` quando omitido. */
  readonly outcomeOf?: (output: Output) => string;
  /** Alimenta as métricas que só o output desse use case consegue dizer (status, replay, divergência). */
  readonly record?: (output: Output, metrics: WageringMetrics) => void;
}

/**
 * Mede o tempo do use case e coloca o outcome como label da execução: o que o output diz, ou a classe do erro
 * lançado (lock_timeout, deadlock, transient, business_rule…). Nada aqui pode mudar o que o use case retorna ou
 * lança, recorder que falha é engolido.
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
      // Métrica nunca pode transformar uma transação já decidida em erro.
    }
    return output;
  }
}
