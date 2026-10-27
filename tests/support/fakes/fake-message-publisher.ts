import type { OutboxMessage } from '../../../src/business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../../src/business/messaging/port/message-publisher.port';

export class PublishFailedError extends Error {
  constructor(id: string) {
    super(`Fake publish failure for ${id}`);
    this.name = 'PublishFailedError';
  }
}

export class FakeMessagePublisher implements IMessagePublisher {
  readonly published: OutboxMessage[] = [];
  private failuresLeft = 0;
  private failing: (message: OutboxMessage) => boolean = () => false;

  failNext(times = 1): void {
    this.failuresLeft += times;
  }

  failWhen(predicate: (message: OutboxMessage) => boolean): void {
    this.failing = predicate;
  }

  recover(): void {
    this.failuresLeft = 0;
    this.failing = () => false;
  }

  async publish(message: OutboxMessage): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new PublishFailedError(message.id);
    }
    if (this.failing(message)) throw new PublishFailedError(message.id);
    this.published.push(message);
  }

  publishedIds(): string[] {
    return this.published.map((message) => message.id);
  }
}
