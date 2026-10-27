import { DomainError } from '../../shared/error/domain-error';

export class InboxMessageAlreadyProcessedError extends DomainError {
  constructor(consumerName: string, messageId: string) {
    super(`Inbox message ${consumerName}/${messageId} was already processed`);
  }
}
