import { OutboxMessage, type OutboxMessageState } from '../../../src/business/messaging/entity/outbox-message';
import type { IOutboxRepository } from '../../../src/business/messaging/port/outbox.repository.port';

const byOccurrence = (a: OutboxMessageState, b: OutboxMessageState): number =>
  a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id);

/**
 * Single-threaded stand-in for `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`: every
 * method runs without awaiting in between, so a claim is atomic relative to other callers.
 */
export class InMemoryOutboxRepository implements IOutboxRepository {
  private readonly rows = new Map<string, OutboxMessageState>();

  async add(messages: readonly OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      if (this.rows.has(message.id)) throw new Error(`Outbox message ${message.id} already exists`);
    }
    for (const message of messages) this.rows.set(message.id, message.toState());
  }

  async claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]> {
    const lockedUntil = new Date(now.getTime() + leaseMs);
    const claimed = [...this.rows.values()]
      .filter((row) => OutboxMessage.rehydrate(row).isDue(now))
      .sort(byOccurrence)
      .slice(0, limit)
      .map((row) => ({ ...row, lockedUntil }));
    for (const row of claimed) this.rows.set(row.id, row);
    return claimed.map((row) => OutboxMessage.rehydrate(row));
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    const stored = this.require(message.id);
    if (stored.publishedAt) return;
    const { lockedUntil: _released, ...rest } = stored;
    this.rows.set(message.id, { ...rest, publishedAt: message.publishedAt });
  }

  async scheduleRetry(message: OutboxMessage): Promise<void> {
    const stored = this.require(message.id);
    if (stored.publishedAt) return;
    const { lockedUntil: _released, ...rest } = stored;
    this.rows.set(message.id, { ...rest, attempts: message.attempts, nextAttemptAt: message.nextAttemptAt });
  }

  async find(id: string): Promise<OutboxMessage | undefined> {
    const stored = this.rows.get(id);
    return stored && OutboxMessage.rehydrate(stored);
  }

  pending(): OutboxMessage[] {
    return [...this.rows.values()].filter((row) => !row.publishedAt).map((row) => OutboxMessage.rehydrate(row));
  }

  private require(id: string): OutboxMessageState {
    const stored = this.rows.get(id);
    if (!stored) throw new Error(`Outbox message ${id} does not exist`);
    return stored;
  }
}
