import { BusinessRuleError } from './business-rule-error';
import { FailureCode } from './failure-code';

export class CurrencyMismatchError extends BusinessRuleError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(FailureCode.CURRENCY_MISMATCH, `Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
