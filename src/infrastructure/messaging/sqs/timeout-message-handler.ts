import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';
import type { IMessageHandler, InboundMessage, MessageOutcome } from './message-handler.port';

/**
 * Limita uma tentativa. Sem isso um banco que para de responder (pausado, particionado) seguraria a tentativa para
 * sempre, e o consumer nunca checaria readiness nem abriria o breaker. Passou do timeout a tentativa é falha
 * transiente, o consumer checa readiness, que não conta a falha enquanto o PostgreSQL está fora.
 * A tentativa abandonada ainda pode commitar depois, aí o retry encontra o inbox processado e faz replay.
 */
export class TimeoutMessageHandler implements IMessageHandler {
  constructor(
    private readonly inner: IMessageHandler,
    private readonly timeoutMs: number,
  ) {}

  async handle(message: InboundMessage, signal: AbortSignal): Promise<MessageOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new TransientInfrastructureError(`Handling ${message.sqsMessageId} took longer than ${this.timeoutMs}ms`, undefined, {
              cause: undefined,
            }),
          ),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([this.inner.handle(message, signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
