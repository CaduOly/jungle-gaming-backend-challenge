import { InboxMessageAlreadyProcessedError } from '../../business/messaging/error/inbox-message-already-processed-error';
import { InboxPayloadMismatchError } from '../../business/messaging/error/inbox-payload-mismatch-error';
import { BusinessRuleError } from '../../business/shared/error/business-rule-error';
import { InvalidRequestError } from '../../business/shared/error/invalid-request-error';
import { UniqueConstraintViolationError } from '../../business/shared/error/unique-constraint-violation-error';
import type { IUseCase } from '../../business/shared/use-case';
import { IdempotencyConflictError } from '../../business/wagering/error/idempotency-conflict-error';
import type {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from '../../business/wagering/use-case/process-wager-transaction/process-wager-transaction.dto';
import { PermanentInfrastructureError } from '../error/permanent-infrastructure-error';
import { DeadLetterReason, type IMessageHandler, type InboundMessage, MessageOutcome } from '../messaging/sqs/message-handler.port';
import { parseWagerCommand } from './wager-command';

export const WAGER_COMMAND_CONSUMER = 'wager-transactions';

export interface WagerCommandHandlerOptions {
  /** Inbox namespace: (consumerName, messageId) is the dedupe key. */
  readonly consumerName?: string;
  /** Alert hook (T11): a permanent infrastructure failure dead-letters a command that may well be valid. */
  readonly onPermanentFailure?: (error: PermanentInfrastructureError, message: InboundMessage) => unknown;
  /** Hook for the metrics decorator (T11): the decision of every processed command. */
  readonly onProcessed?: (output: ProcessWagerTransactionOutput, message: InboundMessage) => unknown;
}

/**
 * The commands queue entry of ProcessWagerTransaction, the same use case as HTTP. On SQS the queue is trusted, so
 * the provider of the payload is the actor, and `data.idempotencyKey` plays the role of the Idempotency-Key header.
 *
 * Outcomes: any decision (PROCESSED, REJECTED, PENDING_REFERENCE, a replay) and every business refusal (unknown
 * wallet, idempotency conflict) → ack, nothing to retry; malformed input → DLQ invalid_schema; the same messageId
 * with another payload → DLQ inbox_payload_mismatch; a lost race on a unique constraint → retry (the next attempt
 * reads the winner's decision); a permanent infrastructure failure → DLQ and alert. Transient infrastructure errors
 * are rethrown so the consumer counts them as transient and retries them with backoff.
 */
export class WagerCommandHandler implements IMessageHandler {
  private readonly consumerName: string;

  constructor(
    private readonly processWager: IUseCase<ProcessWagerTransactionInput, ProcessWagerTransactionOutput>,
    private readonly options: WagerCommandHandlerOptions = {},
  ) {
    this.consumerName = options.consumerName ?? WAGER_COMMAND_CONSUMER;
  }

  async handle(message: InboundMessage): Promise<MessageOutcome> {
    const command = parseWagerCommand(message.body);
    try {
      const output = await this.processWager.execute({
        actor: { providerId: command.submission.providerId },
        idempotencyKey: command.idempotencyKey,
        payload: command.submission,
        source: { channel: 'SQS', consumerName: this.consumerName, messageId: command.messageId },
      });
      notify(() => this.options.onProcessed?.(output, message));
      return MessageOutcome.ack();
    } catch (error) {
      return this.outcomeOf(error, message);
    }
  }

  private outcomeOf(error: unknown, message: InboundMessage): MessageOutcome {
    if (
      error instanceof BusinessRuleError ||
      error instanceof IdempotencyConflictError ||
      error instanceof InboxMessageAlreadyProcessedError
    ) {
      return MessageOutcome.ack();
    }
    if (error instanceof InvalidRequestError) {
      return MessageOutcome.deadLetter(DeadLetterReason.INVALID_SCHEMA, `${error.field} ${error.reason}`);
    }
    if (error instanceof InboxPayloadMismatchError) {
      return MessageOutcome.deadLetter(DeadLetterReason.INBOX_PAYLOAD_MISMATCH, error.message);
    }
    if (error instanceof UniqueConstraintViolationError) return MessageOutcome.retry();
    if (error instanceof PermanentInfrastructureError) {
      notify(() => this.options.onPermanentFailure?.(error, message));
      return MessageOutcome.deadLetter(DeadLetterReason.PERMANENT_INFRASTRUCTURE, error.message);
    }
    throw error;
  }
}

/** An observer must never change the outcome, whether it throws or returns a rejected promise. */
const notify = (callback: () => unknown): void => {
  try {
    Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // see above
  }
};
