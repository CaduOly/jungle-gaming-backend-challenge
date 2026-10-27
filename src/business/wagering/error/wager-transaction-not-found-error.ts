import { DomainError } from '../../shared/error/domain-error';

export class WagerTransactionNotFoundError extends DomainError {
  constructor(reference: string) {
    super(`Wager transaction ${reference} not found`);
  }
}
