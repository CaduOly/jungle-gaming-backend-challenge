import type { DeadLetterReason } from './message-handler.port';

/** Raised by a handler when the message can never be processed as sent: it goes to the DLQ, never retried. */
export class InvalidMessageError extends Error {
  constructor(
    readonly reason: DeadLetterReason,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}
