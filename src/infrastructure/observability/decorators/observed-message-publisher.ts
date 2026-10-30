import type { OutboxMessage } from '../../../business/messaging/entity/outbox-message';
import type { IMessagePublisher } from '../../../business/messaging/port/message-publisher.port';
import type { IClock } from '../../../business/shared/port/clock.port';
import type { WageringMetrics } from '../metrics/wagering-metrics';

/**
 * Observa o outbox_lag_seconds quando o evento é publicado de fato: o tempo desde o commit que gravou ele
 * (o occurredAt é definido nessa mesma transação). Publish que falhou não observa nada, ele conta como retry.
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
