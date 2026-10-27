import { DomainError } from '../../shared/error/domain-error';

export class InvalidOutboxRetryError extends DomainError {
  constructor(delayMs: number) {
    super(`Invalid outbox retry delay: ${delayMs}ms (expected a non-negative integer)`);
  }
}
