import { DomainError } from './domain-error';

export class InvalidTransactionStateError extends DomainError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid transaction state transition: ${from} -> ${to}`);
  }
}
