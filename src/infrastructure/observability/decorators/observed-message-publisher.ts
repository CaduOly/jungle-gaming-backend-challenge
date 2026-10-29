import type { OutboxMessage } from '../../../business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../../business/messaging/port/message-publisher.port';
import type { IClock } from '../../../business/shared/port/clock.port';
import type { WageringMetrics } from '../metrics/wagering-metrics';

/**
 * Observes outbox_lag_seconds when an event is actually published: the time since the commit that wrote it
 * (occurredAt is set in that same transaction). A failed publish observes nothing; it is counted as a retry.
 */
export class ObservedMessagePublisher implements IMessagePublisher {
  constructor(
    private readonly inner: IMessagePublisher,
    private readonly metrics: WageringMetrics,
    private readonly clock: IClock,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inner.publish(message);
    const lagMs = this.clock.now().getTime() - message.occurredAt.getTime();
    this.metrics.outboxLag.observe(Math.max(0, lagMs) / 1000);
  }
}
