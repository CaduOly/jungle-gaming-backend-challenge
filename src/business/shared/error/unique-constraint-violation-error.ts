import { DomainError } from './domain-error';

/**
 * Uma escrita perdeu a corrida para um commit concorrente numa unique constraint (Postgres 23505).
 * Lançado pelos adapters de persistência, a transação que bateu nisso já está perdida e precisa de rollback.
 */
export class UniqueConstraintViolationError extends DomainError {
  constructor(
    readonly constraint: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`Unique constraint violated: ${constraint}`);
    if (options !== undefined) this.cause = options.cause;
  }
}
