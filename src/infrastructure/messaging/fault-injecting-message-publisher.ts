import type { OutboxMessage } from '../../business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../business/messaging/port/message-publisher.port';
import type { FaultInjector } from '../fault-injection/fault-injector';

/** Morre logo depois de um publish com sucesso, antes do PublishOutboxBatch marcar a linha como publicada. */
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
