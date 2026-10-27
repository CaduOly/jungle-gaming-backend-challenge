import { DomainError } from '../../shared/error/domain-error';

export class OutboxMessageAlreadyPublishedError extends DomainError {
  constructor(id: string) {
    super(`Outbox message ${id} was already published`);
  }
}
