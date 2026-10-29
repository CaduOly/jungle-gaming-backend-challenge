import { DomainError } from '../../shared/error/domain-error';
import type { InputRule, InputViolation } from '../../shared/error/input-rule';

/** A broken invariant of the transaction. When the input caused it, `field` and `rule` say where and which. */
export class InvalidWagerTransactionError extends DomainError {
  readonly field?: string;
  readonly rule?: InputRule;

  constructor(reason: string, violation?: InputViolation) {
    super(`Invalid wager transaction: ${reason}`);
    if (violation !== undefined) {
      this.field = violation.field;
      this.rule = violation.rule;
    }
  }
}
