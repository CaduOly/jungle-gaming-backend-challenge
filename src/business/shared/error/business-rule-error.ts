import { DomainError } from './domain-error';
import type { FailureCode } from './failure-code';

export abstract class BusinessRuleError extends DomainError {
  protected constructor(
    readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
