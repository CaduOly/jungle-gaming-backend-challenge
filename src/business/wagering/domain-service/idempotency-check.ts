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
 * Mesmo (provider, idempotency key) com o mesmo hash de payload é replay, com outro hash é conflito.
 * Mesmo (provider, external id) com outra key é transação externa duplicada.
 */
export class IdempotencyCheck {
  constructor(private readonly transactions: Pick<IWagerTransactionReader, 'findByIdempotencyKey' | 'findByExternalId'>) {}

  /**
   * As duas buscas são leituras separadas, então sem o lock da wallet (no pre-check) a própria requisição pode fazer
   * commit entre elas, por isso uma linha achada por external id com a mesma key é tratada como match de key.
   */
  async check(request: IdempotencyRequest): Promise<IdempotencyDecision> {
    const sameKey = await this.transactions.findByIdempotencyKey(request.providerId, request.idempotencyKey);
    if (sameKey !== null) return IdempotencyCheck.byKey(sameKey, request);
    const sameExternalId = await this.transactions.findByExternalId(request.providerId, request.externalTransactionId);
    if (sameExternalId === null) return { type: 'New' };
    if (sameExternalId.idempotencyKey === request.idempotencyKey) return IdempotencyCheck.byKey(sameExternalId, request);
    return { type: 'Conflict', code: FailureCode.DUPLICATE_EXTERNAL_TRANSACTION, existing: sameExternalId };
  }

  private static byKey(existing: WagerTransaction, request: IdempotencyRequest): IdempotencyDecision {
    return existing.matchesPayload(request.payloadHash)
      ? { type: 'Replay', existing }
      : { type: 'Conflict', code: FailureCode.IDEMPOTENCY_CONFLICT, existing };
  }
}
