import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';
import type { IMessageHandler, InboundMessage, MessageOutcome } from './message-handler.port';

/**
 * Bounds one attempt. A database that stops answering (paused, partitioned) would otherwise hold the attempt
 * forever, and the consumer would never probe readiness nor open its breaker. Past the timeout the attempt is a
 * transient failure: the consumer checks readiness, which does not count the failure while PostgreSQL is down.
 * The abandoned attempt may still commit later; the retry then finds the inbox processed and replays.
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
