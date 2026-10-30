import { DomainError } from '../../shared/error/domain-error';

/** Mesmo messageId reentregue com payload diferente: violação de contrato permanente (DLQ). */
export class InboxPayloadMismatchError extends DomainError {
  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(`Inbox message ${consumerName}/${messageId} was redelivered with a different payload`);
  }
}
