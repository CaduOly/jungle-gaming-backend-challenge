import { DomainError } from './domain-error';

/** Malformed use case input (400): the request can only succeed if the caller changes it. */
export class InvalidRequestError extends DomainError {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`Invalid request: ${field} ${reason}`);
  }
}
