import { DomainError } from './domain-error';

export class InvalidBackoffConfigurationError extends DomainError {
  constructor(reason: string) {
    super(`Invalid exponential backoff: ${reason}`);
  }
}
