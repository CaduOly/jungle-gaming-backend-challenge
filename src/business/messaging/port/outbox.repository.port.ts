import type { OutboxMessage } from '../entity/outbox-message';

export interface IOutboxRepository {
  add(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * Atomically leases up to `limit` due messages (unpublished, nextAttemptAt <= now, lease free or
   * expired) by setting lockedUntil = now + leaseMs. A leased message is not claimed again until
   * the lease expires, so concurrent publishers never share a row.
   */
  claimBatch(limit: number, leaseMs: number, now: Date): Promise<OutboxMessage[]>;
  /** No-op when the row is already published (another publisher won after a lease expiry). */
  markPublished(message: OutboxMessage): Promise<void>;
  /** Persists attempts/nextAttemptAt and releases the lease. No-op when the row is already published. */
  scheduleRetry(message: OutboxMessage): Promise<void>;
}
