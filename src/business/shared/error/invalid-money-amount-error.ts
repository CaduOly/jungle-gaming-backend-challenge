import { describeInput } from './describe-input';
import { DomainError } from './domain-error';

export class InvalidMoneyAmountError extends DomainError {
  constructor(amount: unknown) {
    super(
      `Invalid money amount ${describeInput(amount)}: expected a decimal string with exactly 2 decimal places, e.g. "25.00"`,
    );
  }
}
