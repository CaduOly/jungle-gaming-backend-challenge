import type { IUseCase } from '../../../business/shared/use-case';
import { type LogContext, bindLogContext, runWithLogContext } from '../logging/log-context';
import type { Logger } from '../logging/logger';
import { classifyError, describeError, isExpectedError } from '../metrics/error-classification';

export type LogFields = Partial<Record<keyof LogContext, unknown>>;

export interface UseCaseLoggingOptions<Input, Output> {
  readonly operation: string;
  /** Identificadores conhecidos pelo input (providerId, walletId, messageId…), ligados a toda linha da execução. */
  readonly contextOf?: (input: Input) => LogFields;
  /**
   * O que a linha pode dizer sobre o resultado. Não pode retornar dinheiro: o logger já faz redact dos campos de
   * dinheiro comuns, mas o summary é o lugar de deixar eles de fora desde o começo.
   */
  readonly summaryOf?: (output: Output) => Record<string, unknown>;
}

const nowMs = (): number => performance.now();

/**
 * Uma linha por execução: `<operation> completed` com o summary, ou `<operation> failed` com a classe do erro.
 * Resposta de domínio (400/404/409/422) loga em info, infraestrutura transiente em warn, o resto em error.
 */
export class LoggingUseCaseDecorator<Input, Output> implements IUseCase<Input, Output> {
  constructor(
    private readonly inner: IUseCase<Input, Output>,
    private readonly logger: Logger,
    private readonly options: UseCaseLoggingOptions<Input, Output>,
  ) {}

  execute(input: Input): Promise<Output> {
    const context = safely(() => this.options.contextOf?.(input)) ?? {};
    return runWithLogContext(context, () => this.run(input));
  }

  private async run(input: Input): Promise<Output> {
    const { operation } = this.options;
    const startedAt = nowMs();
    let output: Output;
    try {
      output = await this.inner.execute(input);
    } catch (error) {
      const errorClass = classifyError(error);
      const level = isExpectedError(errorClass) ? 'info' : errorClass === 'unexpected' || errorClass === 'permanent' ? 'error' : 'warn';
      safely(() => this.logger[level]({ operation, durationMs: elapsed(startedAt), ...describeError(error) }, `${operation} failed`));
      throw error;
    }
    safely(() => {
      const summary = this.options.summaryOf?.(output) ?? {};
      bindLogContext(summary);
      this.logger.info({ operation, durationMs: elapsed(startedAt), ...summary }, `${operation} completed`);
    });
    return output;
  }
}

const elapsed = (startedAt: number): number => Math.round((nowMs() - startedAt) * 1000) / 1000;

const safely = <T>(work: () => T): T | undefined => {
  try {
    return work();
  } catch {
    return undefined;
  }
};
