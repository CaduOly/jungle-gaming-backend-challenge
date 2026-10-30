import type { OutboxMessage } from '../../business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../business/messaging/port/message-publisher.port';

export class PublishTimeoutError extends Error {
  constructor(
    readonly messageId: string,
    readonly timeoutMs: number,
  ) {
    super(`Publishing ${messageId} took longer than ${timeoutMs}ms`);
    this.name = 'PublishTimeoutError';
  }
}

/**
 * Limita o publish para a rodada sempre caber no lease. Um publish que deu timeout ainda pode chegar no broker, aí
 * ele é retentado e publicado duas vezes, o que a entrega at-least-once e o dedup por eventId já absorvem.
 */
export class TimeoutMessagePublisher implements IMessagePublisher {
  constructor(
    private readonly inner: IMessagePublisher,
    private readonly timeoutMs: number,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PublishTimeoutError(message.id, this.timeoutMs)), this.timeoutMs);
    });
    try {
      await Promise.race([this.inner.publish(message), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
