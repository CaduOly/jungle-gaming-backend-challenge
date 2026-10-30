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
   * Problema de infraestrutura, para os observers de outcome (métricas). Sozinho não alimenta o circuit breaker:
   * depois de toda tentativa que falha o consumer faz o probe de readiness, e é esse probe que alimenta, então um
   * lock timeout numa wallet quente nunca pausa o consumer inteiro.
   */
  readonly transient: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const deadLetter = (reason: DeadLetterReason, error: unknown): ClassifiedError => ({
  outcome: MessageOutcome.deadLetter(reason, messageOf(error)),
  transient: false,
});

/**
 * regra de negócio → ack (a rejeição é a resposta); infraestrutura transiente → retry com backoff;
 * permanente (mensagem ruim, hash do inbox divergente, guarda de integridade, qualquer outra invariante do domínio)
 * → DLQ. Qualquer coisa não reconhecida também tem retry, e vai para a DLQ como retries_exhausted quando os retries
 * acabam.
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
