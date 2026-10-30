import { DomainError } from '../../shared/error/domain-error';
import type { InputRule, InputViolation } from '../../shared/error/input-rule';

/** Invariante da transação quebrada. Quando foi o input que causou, `field` e `rule` dizem onde e qual. */
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
