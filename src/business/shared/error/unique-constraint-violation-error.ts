import { DomainError } from './domain-error';

/**
 * A write lost a race against a concurrent commit on a unique constraint (Postgres 23505).
 * Raised by persistence adapters; the transaction that hit it is already doomed and must be rolled back.
 */
export class UniqueConstraintViolationError extends DomainError {
  constructor(readonly constraint: string) {
    super(`Unique constraint violated: ${constraint}`);
  }
}
