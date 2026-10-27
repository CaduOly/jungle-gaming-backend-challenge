import { DomainError } from './domain-error';

export class NegativeMoneyError extends DomainError {
  constructor() {
    super('Money subtraction would result in a negative amount');
  }
}
