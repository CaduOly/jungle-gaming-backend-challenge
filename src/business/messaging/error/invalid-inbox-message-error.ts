import { DomainError } from '../../shared/error/domain-error';

export class InvalidInboxMessageError extends DomainError {
  constructor(field: string) {
    super(`Invalid inbox message: ${field} is required and must be valid`);
  }
}
