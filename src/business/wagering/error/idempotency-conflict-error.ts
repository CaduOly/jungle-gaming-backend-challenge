import { DomainError } from '../../shared/error/domain-error';
import type { IdempotencyConflictCode } from '../domain-service/idempotency-check';

/** 409: the key (or the external id) is already bound to a different request. Never persisted. */
export class IdempotencyConflictError extends DomainError {
  constructor(
    readonly failureCode: IdempotencyConflictCode,
    readonly existingTransactionId: string,
  ) {
    super(`${failureCode}: the request conflicts with transaction ${existingTransactionId}`);
  }
}
