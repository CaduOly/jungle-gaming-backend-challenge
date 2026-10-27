import type { ExponentialBackoff } from '../../../shared/policy/exponential-backoff';
import type { IClock } from '../../../shared/port/clock.port';
import type { IUseCase } from '../../../shared/use-case';
import type { OutboxMessage } from '../../entity/outbox-message';
import type { IMessagePublisher } from '../../port/message-publisher.port';
import type { IOutboxRepository } from '../../port/outbox.repository.port';

export interface PublishOutboxBatchConfig {
  readonly batchSize: number;
  readonly leaseMs: number;
}

export interface PublishOutboxBatchOutput {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  /**
   * Messages handed back without an attempt because an earlier message of the same aggregate failed in this
   * run: they wait for its retry time, so they never go on the wire ahead of it.
   */
  readonly deferred: number;
  /** Failures whose retry was fenced off because the lease expired and another publisher took the message. */
  readonly leaseLost: number;
  /**
   * Subset of `failed` that reached the attempt ceiling in this run (reported once per message).
   * They are never dropped: retries continue at the capped delay.
   */
  readonly exhausted: number;
  readonly exhaustedMessageIds: readonly string[];
}

export class PublishOutboxBatch implements IUseCase<void, PublishOutboxBatchOutput> {
  constructor(
    private readonly outbox: IOutboxRepository,
    private readonly publisher: IMessagePublisher,
    private readonly clock: IClock,
    private readonly backoff: ExponentialBackoff,
    private readonly config: PublishOutboxBatchConfig,
  ) {}

  async execute(): Promise<PublishOutboxBatchOutput> {
    const claimed = await this.outbox.claimBatch(this.config.batchSize, this.config.leaseMs, this.clock.now());
    let published = 0;
    let failed = 0;
    let leaseLost = 0;
    let deferred = 0;
    const exhaustedMessageIds: string[] = [];
    const blockedUntil = new Map<string, Date>();

    for (const message of claimed) {
      const blocked = blockedUntil.get(message.aggregateId);
      if (blocked !== undefined) {
        if (await this.outbox.defer(message, blocked)) deferred += 1;
        else leaseLost += 1;
        continue;
      }
      if (await this.tryPublish(message)) {
        message.markPublished(this.clock.now());
        await this.outbox.markPublished(message);
        published += 1;
        continue;
      }
      const wasExhausted = this.backoff.isExhausted(message.attempts);
      message.scheduleRetry(this.clock.now(), this.backoff.nextDelayMs(message.attempts + 1));
      blockedUntil.set(message.aggregateId, message.nextAttemptAt);
      failed += 1;
      if (!(await this.outbox.scheduleRetry(message))) {
        leaseLost += 1;
        continue;
      }
      if (!wasExhausted && this.backoff.isExhausted(message.attempts)) exhaustedMessageIds.push(message.id);
    }

    return {
      claimed: claimed.length,
      published,
      failed,
      deferred,
      leaseLost,
      exhausted: exhaustedMessageIds.length,
      exhaustedMessageIds,
    };
  }

  private async tryPublish(message: OutboxMessage): Promise<boolean> {
    try {
      await this.publisher.publish(message);
      return true;
    } catch {
      return false;
    }
  }
}
