import { DomainError } from '../../shared/error/domain-error';

/** Same messageId redelivered with a different payload: a permanent contract violation (DLQ). */
export class InboxPayloadMismatchError extends DomainError {
  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(`Inbox message ${consumerName}/${messageId} was redelivered with a different payload`);
  }
}
