import { DomainError } from './domain-error';
import type { InputRule } from './input-rule';

/** Malformed use case input (400): the request can only succeed if the caller changes it. */
export class InvalidRequestError extends DomainError {
  constructor(
    /** Dotted path of the offending field, e.g. `money.amount`. */
    readonly field: string,
    readonly reason: string,
    readonly rule?: InputRule,
  ) {
    super(`Invalid request: ${field} ${reason}`);
  }
}
