import { DomainError } from '../../shared/error/domain-error';

export class InvalidWagerTransactionError extends DomainError {
  constructor(reason: string) {
    super(`Invalid wager transaction: ${reason}`);
  }
}
