import type { IUseCase } from '../../business/shared/use-case';
import type {
  RetryPendingReferencesInput,
  RetryPendingReferencesOutput,
} from '../../business/wagering/use-case/retry-pending-references/retry-pending-references';
import { PollingLoop } from '../worker/polling-loop';

export type RetryPendingRound = IUseCase<RetryPendingReferencesInput | void, RetryPendingReferencesOutput>;

export interface PendingReferenceWorkerOptions {
  /** Rodada que pegou essa quantidade de itens pode ter deixado mais vencidos para trás, então a próxima começa na hora. */
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  /** Saída de toda rodada terminada, é o hook onde o decorator de métricas se pluga. */
  readonly onRound?: (output: RetryPendingReferencesOutput) => unknown;
  /** Rodada que lançou erro (o próprio claim falhou, banco fora por exemplo). O loop continua. */
  readonly onError?: (error: unknown) => unknown;
}

/**
 * Roda o RetryPendingReferences uma rodada por vez. Batch cheio é seguido na hora pela próxima rodada para drenar
 * o backlog, e batch parcial ou com falha espera o poll interval, já que não tem mais nada vencido. Depois que o
 * `stop()` resolve o worker pode ser iniciado de novo, mas iniciar enquanto um stop ainda espera a rodada lança erro.
 */
export class PendingReferenceWorker {
  private readonly loop: PollingLoop<RetryPendingReferencesOutput>;

  constructor(
    private readonly round: RetryPendingRound,
    options: PendingReferenceWorkerOptions,
  ) {
    this.loop = new PollingLoop({
      round: () => this.runOnce(),
      nextDelayMs: (output) => (output.claimed >= options.batchSize ? 0 : options.pollIntervalMs),
      errorDelayMs: options.pollIntervalMs,
      ...(options.onRound === undefined ? {} : { onRound: options.onRound }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
  }

  get isRunning(): boolean {
    return this.loop.isRunning;
  }

  start(): void {
    this.loop.start();
  }

  runOnce(): Promise<RetryPendingReferencesOutput> {
    return this.round.execute({ shouldStop: () => this.loop.isStopping });
  }

  /**
   * Para o polling e resolve quando a rodada em andamento termina o item em que está, já que a rodada checa entre
   * os itens, então a espera é de um item (no pior caso os dois lock waits dele), nunca de um batch inteiro.
   */
  stop(): Promise<void> {
    return this.loop.stop();
  }
}
