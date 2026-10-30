import type { PublishOutboxBatchOutput } from '../../../business/messaging/use-case/publish-outbox-batch/publish-outbox-batch';
import type { IUseCase } from '../../../business/shared/use-case';
import { PollingLoop } from '../../worker/polling-loop';

export type PublishOutboxRound = IUseCase<void, PublishOutboxBatchOutput>;

export interface OutboxPublisherWorkerOptions {
  readonly pollIntervalMs: number;
  /** Saída de toda rodada terminada, é o hook onde o decorator de métricas se pluga. */
  readonly onRound?: (output: PublishOutboxBatchOutput) => unknown;
  /** Rodada que lançou erro (banco fora, por exemplo). O loop continua depois do poll interval. */
  readonly onError?: (error: unknown) => unknown;
}

/**
 * Faz polling do outbox, uma rodada por vez. Rodada que publicou alguma coisa é seguida na hora pela próxima, para
 * drenar backlog, e rodada vazia ou com falha espera o poll interval. O `createRound` é chamado por rodada para cada
 * uma ganhar um fork novo do EntityManager. Depois que o `stop()` resolve o worker pode ser iniciado de novo, mas
 * iniciar enquanto um stop ainda espera a rodada dele lança erro.
 */
export class OutboxPublisherWorker {
  private readonly loop: PollingLoop<PublishOutboxBatchOutput>;

  constructor(
    private readonly createRound: () => PublishOutboxRound,
    options: OutboxPublisherWorkerOptions,
  ) {
    this.loop = new PollingLoop({
      round: () => this.runOnce(),
      nextDelayMs: (output) => (output.published > 0 ? 0 : options.pollIntervalMs),
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

  runOnce(): Promise<PublishOutboxBatchOutput> {
    return this.createRound().execute();
  }

  /** Para o polling e resolve quando a rodada em andamento, se tiver, terminar. */
  stop(): Promise<void> {
    return this.loop.stop();
  }
}
