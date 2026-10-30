import { DomainError } from './domain-error';

export class NegativeMoneyError extends DomainError {
  constructor() {
    super('Money amount cannot be negative');
  }
}
