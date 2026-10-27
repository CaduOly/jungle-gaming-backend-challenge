import type { OutboxMessage } from '../../business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../business/messaging/port/message-publisher.port';
import type { FaultInjector } from '../fault-injection/fault-injector';

/** Dies right after a successful publish, before PublishOutboxBatch gets to mark the row as published. */
export class FaultInjectingMessagePublisher implements IMessagePublisher {
  constructor(
    private readonly inner: IMessagePublisher,
    private readonly faults: FaultInjector,
    private readonly kill?: () => void,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inner.publish(message);
    this.faults.crash('crash_after_publish_before_mark', this.kill);
  }
}
