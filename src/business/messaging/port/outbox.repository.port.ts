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
   * Records the publication and releases the lease. Not fenced (the message did go out), but a no-op when
   * the row is already published, and it never touches attempts or nextAttemptAt.
   */
  markPublished(message: OutboxMessage): Promise<void>;
  /**
   * Persists attempts/nextAttemptAt and releases the lease, only while `message.leaseToken` still owns the
   * row and it is unpublished (`… WHERE id = $1 AND published_at IS NULL AND lease_token = $2`).
   * Returns false when the write was fenced off: the lease expired and another publisher reclaimed it.
   */
  scheduleRetry(message: OutboxMessage): Promise<boolean>;
  findById(id: string): Promise<OutboxMessage | undefined>;
}
