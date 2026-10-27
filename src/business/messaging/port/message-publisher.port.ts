import type { OutboxMessage } from '../entity/outbox-message';

export interface IMessagePublisher {
  publish(message: OutboxMessage): Promise<void>;
}
