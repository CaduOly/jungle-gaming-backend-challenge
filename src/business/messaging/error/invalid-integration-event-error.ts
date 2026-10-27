import { DomainError } from '../../shared/error/domain-error';

export class InvalidIntegrationEventError extends DomainError {
  constructor(field: string) {
    super(`Invalid integration event: ${field} is required and must be valid`);
  }
}
