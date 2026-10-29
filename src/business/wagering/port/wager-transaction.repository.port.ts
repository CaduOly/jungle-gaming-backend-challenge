import type { WagerTransaction } from '../entity/wager-transaction';

export interface ClaimPendingBatch {
  limit: number;
  leaseMs: number;
  now: Date;
}

/** Scoped to the current unit of work. */
export interface IWagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Row lock until the unit of work ends; always taken after the wallet lock. */
  lockById(id: string): Promise<WagerTransaction | null>;
  /** Unique (provider, idempotency key), (provider, external id) and one processed reversal per reference. */
  insert(transaction: WagerTransaction): Promise<void>;
  /** Requires the row lock; also releases the claim lease (`locked_until = NULL`), so the next attempt is gated only by nextAttemptAt. */
  update(transaction: WagerTransaction): Promise<void>;
  /** True when a PROCESSED REFUND or ROLLBACK already points at this transaction. */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /** Leases due PENDING_REFERENCE ids (SKIP LOCKED) so other instances skip them until the lease ends. */
  claimPendingBatch(batch: ClaimPendingBatch): Promise<string[]>;
}

export type IWagerTransactionReader = Pick<
  IWagerTransactionRepository,
  'findByIdempotencyKey' | 'findByExternalId' | 'isReversed'
>;
