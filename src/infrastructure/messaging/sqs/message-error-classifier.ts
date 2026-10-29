import { InboxMessageAlreadyProcessedError } from '../../../business/messaging/error/inbox-message-already-processed-error';
import { InboxPayloadMismatchError } from '../../../business/messaging/error/inbox-payload-mismatch-error';
import { BusinessRuleError } from '../../../business/shared/error/business-rule-error';
import { DomainError } from '../../../business/shared/error/domain-error';
import { PermanentInfrastructureError } from '../../error/permanent-infrastructure-error';
import { TransientInfrastructureError } from '../../error/transient-infrastructure-error';
import { InvalidMessageError } from './invalid-message-error';
import { DeadLetterReason, MessageOutcome } from './message-handler.port';

export interface ClassifiedError {
  readonly outcome: MessageOutcome;
  /**
   * Infrastructure trouble, for the outcome observers (metrics). It does not feed the circuit breaker by
   * itself: after every failed attempt the consumer probes readiness, and that probe is what feeds it, so a
   * lock timeout on one hot wallet never pauses the whole consumer.
   */
  readonly transient: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const deadLetter = (reason: DeadLetterReason, error: unknown): ClassifiedError => ({
  outcome: MessageOutcome.deadLetter(reason, messageOf(error)),
  transient: false,
});

/**
 * business rule → ack (the rejection is the answer); transient infrastructure → retry with backoff;
 * permanent (bad message, inbox hash mismatch, integrity guard, any other domain invariant) → DLQ.
 * Anything unrecognised is retried too, and dead-lettered as retries_exhausted once the retries run out.
 */
export const classifyMessageError = (error: unknown): ClassifiedError => {
  if (error instanceof BusinessRuleError || error instanceof InboxMessageAlreadyProcessedError) {
    return { outcome: MessageOutcome.ack(), transient: false };
  }
  if (error instanceof TransientInfrastructureError) return { outcome: MessageOutcome.retry(), transient: true };
  if (error instanceof InvalidMessageError) return deadLetter(error.reason, error);
  if (error instanceof InboxPayloadMismatchError) return deadLetter(DeadLetterReason.INBOX_PAYLOAD_MISMATCH, error);
  if (error instanceof PermanentInfrastructureError) return deadLetter(DeadLetterReason.PERMANENT_INFRASTRUCTURE, error);
  if (error instanceof DomainError) return deadLetter(DeadLetterReason.CONTRACT_VIOLATION, error);
  return { outcome: MessageOutcome.retry(), transient: false };
};
