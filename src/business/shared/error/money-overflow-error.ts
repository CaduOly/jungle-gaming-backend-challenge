import { DomainError } from './domain-error';

export class MoneyOverflowError extends DomainError {
  constructor() {
    super('Money amount exceeds the maximum of 999999999999999999.99');
  }
}
