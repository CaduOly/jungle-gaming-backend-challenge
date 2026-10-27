import type { OutboxMessage } from '../entity/outbox-message';

export interface IOutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * Atomically leases up to `limit` due messages (unpublished, nextAttemptAt <= now, lease free or expired),
   * oldest first, setting lockedUntil = now + leaseMs and a fresh leaseToken. A leased message is not
   * claimed again until the lease expires, so concurrent publishers never share a row.
   */
  claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]>;
  /**
   * Records the publication and releases the lease. Deliberately not fenced by the lease token: the message
   * did reach the broker, so even a publisher whose lease expired must record it, otherwise the row would be
   * published once more for nothing. Delivery is at-least-once and consumers dedupe by eventId, so a stale
   * mark is safe. It is a no-op when the row is already published (returns false: someone else recorded it
   * first) and never touches attempts or nextAttemptAt.
   */
  markPublished(message: OutboxMessage): Promise<boolean>;
  /**
   * Persists attempts/nextAttemptAt and releases the lease, only while `message.leaseToken` still owns the
   * row and it is unpublished (`… WHERE id = $1 AND published_at IS NULL AND lease_token = $2`).
   * Returns false when the write was fenced off: the lease expired and another publisher reclaimed it.
   */
  scheduleRetry(message: OutboxMessage): Promise<boolean>;
  /**
   * Gives a claimed message back without counting an attempt: clears the lease and pushes nextAttemptAt to
   * `until` (never earlier than it already is). Fenced by the lease token like scheduleRetry; returns false
   * when the lease was already lost.
   */
  defer(message: OutboxMessage, until: Date): Promise<boolean>;
  findById(id: string): Promise<OutboxMessage | undefined>;
}
