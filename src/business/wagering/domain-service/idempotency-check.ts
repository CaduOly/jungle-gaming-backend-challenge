import { FailureCode } from '../../shared/error/failure-code';
import type { WagerTransaction } from '../entity/wager-transaction';
import type { IWagerTransactionReader } from '../port/wager-transaction.repository.port';

export interface IdempotencyRequest {
  providerId: string;
  idempotencyKey: string;
  externalTransactionId: string;
  payloadHash: string;
}

export type IdempotencyConflictCode =
  | typeof FailureCode.IDEMPOTENCY_CONFLICT
  | typeof FailureCode.DUPLICATE_EXTERNAL_TRANSACTION;

export type IdempotencyDecision =
  | { type: 'New' }
  | { type: 'Replay'; existing: WagerTransaction }
  | { type: 'Conflict'; code: IdempotencyConflictCode; existing: WagerTransaction };

/**
 * Same (provider, idempotency key) with the same payload hash is a replay; with another hash it is
 * a conflict. Same (provider, external id) under a different key is a duplicate external transaction.
 */
export class IdempotencyCheck {
  constructor(private readonly transactions: Pick<IWagerTransactionReader, 'findByIdempotencyKey' | 'findByExternalId'>) {}

  async check(request: IdempotencyRequest): Promise<IdempotencyDecision> {
    const sameKey = await this.transactions.findByIdempotencyKey(request.providerId, request.idempotencyKey);
    if (sameKey !== null) {
      return sameKey.matchesPayload(request.payloadHash)
        ? { type: 'Replay', existing: sameKey }
        : { type: 'Conflict', code: FailureCode.IDEMPOTENCY_CONFLICT, existing: sameKey };
    }
    const sameExternalId = await this.transactions.findByExternalId(request.providerId, request.externalTransactionId);
    if (sameExternalId !== null) {
      return { type: 'Conflict', code: FailureCode.DUPLICATE_EXTERNAL_TRANSACTION, existing: sameExternalId };
    }
    return { type: 'New' };
  }
}
