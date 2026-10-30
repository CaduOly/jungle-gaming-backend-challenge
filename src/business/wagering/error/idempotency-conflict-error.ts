import { DomainError } from '../../shared/error/domain-error';
import type { IdempotencyConflictCode } from '../domain-service/idempotency-check';

/** 409: a key (ou o external id) já está ligada a outra requisição. Nunca é persistido. */
export class IdempotencyConflictError extends DomainError {
  constructor(
    readonly failureCode: IdempotencyConflictCode,
    readonly existingTransactionId: string,
  ) {
    super(`${failureCode}: the request conflicts with transaction ${existingTransactionId}`);
  }
}
