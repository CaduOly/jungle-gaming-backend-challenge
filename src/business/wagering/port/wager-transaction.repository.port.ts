import type { WagerTransaction } from '../entity/wager-transaction';

export interface ClaimPendingBatch {
  limit: number;
  leaseMs: number;
  now: Date;
}

/** Restrito à unit of work atual. */
export interface IWagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Row lock até a unit of work terminar, sempre pego depois do lock da wallet. */
  lockById(id: string): Promise<WagerTransaction | null>;
  /** Unique em (provider, idempotency key), (provider, external id) e um reversal processado por referência. */
  insert(transaction: WagerTransaction): Promise<void>;
  /** Exige o row lock e também libera o lease do claim (`locked_until = NULL`), então a próxima tentativa depende só do nextAttemptAt. */
  update(transaction: WagerTransaction): Promise<void>;
  /** True quando um REFUND ou ROLLBACK PROCESSED já aponta para essa transação. */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /** Pega lease dos ids PENDING_REFERENCE vencidos (SKIP LOCKED) para as outras instâncias pularem eles até o lease acabar. */
  claimPendingBatch(batch: ClaimPendingBatch): Promise<string[]>;
}

export type IWagerTransactionReader = Pick<
  IWagerTransactionRepository,
  'findByIdempotencyKey' | 'findByExternalId' | 'isReversed'
>;
