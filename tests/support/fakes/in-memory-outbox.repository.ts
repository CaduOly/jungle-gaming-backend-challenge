import { OutboxMessage, type OutboxMessageState } from '../../../src/business/messaging/entity/outbox-message';
import type { IOutboxRepository } from '../../../src/business/messaging/port/outbox.repository.port';
import { uuidv7 } from '../uuid';

const byOccurrence = (a: OutboxMessageState, b: OutboxMessageState): number =>
  a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id);

const withoutLease = ({ lockedUntil: _lockedUntil, leaseToken: _leaseToken, ...rest }: OutboxMessageState) => rest;

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
    for (const message of messages) this.rows.set(message.id, withoutLease(message.toState()));
  }

  async claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]> {
    const lockedUntil = new Date(now.getTime() + leaseMs);
    const claimed = [...this.rows.values()]
      .filter((row) => OutboxMessage.rehydrate(row).isDue(now))
      .sort(byOccurrence)
      .slice(0, limit)
      .map((row) => ({ ...row, lockedUntil, leaseToken: uuidv7() }));
    for (const row of claimed) this.rows.set(row.id, row);
    return claimed.map((row) => OutboxMessage.rehydrate(row));
  }

  async markPublished(message: OutboxMessage): Promise<boolean> {
    const stored = this.require(message.id);
    if (stored.publishedAt) return false;
    this.rows.set(message.id, { ...withoutLease(stored), publishedAt: message.publishedAt });
    return true;
  }

  async scheduleRetry(message: OutboxMessage): Promise<boolean> {
    const stored = this.require(message.id);
    if (stored.publishedAt || message.leaseToken === undefined || stored.leaseToken !== message.leaseToken) {
      return false;
    }
    this.rows.set(message.id, {
      ...withoutLease(stored),
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
    });
    return true;
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
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
