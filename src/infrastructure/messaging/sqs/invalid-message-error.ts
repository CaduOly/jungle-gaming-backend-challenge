import type { DeadLetterReason } from './message-handler.port';

/** Lançado pelo handler quando a mensagem nunca vai poder ser processada do jeito que veio: vai para a DLQ, sem retry. */
export class InvalidMessageError extends Error {
  constructor(
    readonly reason: DeadLetterReason,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}
