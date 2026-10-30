import { describeInput } from './describe-input';
import { DomainError } from './domain-error';

export class InvalidCurrencyError extends DomainError {
  constructor(currency: unknown) {
    super(`Invalid currency ${describeInput(currency)}: expected an ISO-4217 code, e.g. "BRL"`);
  }
}
