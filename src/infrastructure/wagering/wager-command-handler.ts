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
  /** Namespace do inbox: (consumerName, messageId) é a chave de dedup. */
  readonly consumerName?: string;
  /** Hook de alerta: uma falha permanente de infraestrutura manda para a DLQ um comando que pode muito bem ser válido. */
  readonly onPermanentFailure?: (error: PermanentInfrastructureError, message: InboundMessage) => unknown;
  /** Hook para o decorator de métricas: a decisão de todo comando processado. */
  readonly onProcessed?: (output: ProcessWagerTransactionOutput, message: InboundMessage) => unknown;
}

/**
 * Entrada do ProcessWagerTransaction pela fila de comandos, o mesmo use case do HTTP. No SQS a fila é confiável,
 * então o provider do payload é o actor, e o `data.idempotencyKey` faz o papel do header Idempotency-Key.
 *
 * Outcomes: qualquer decisão (PROCESSED, REJECTED, PENDING_REFERENCE, um replay) e toda recusa de negócio (wallet
 * desconhecida, conflito de idempotência) → ack, nada para retentar; input malformado → DLQ invalid_schema; mesmo
 * messageId com outro payload → DLQ inbox_payload_mismatch; corrida perdida numa unique constraint → retry (a
 * próxima tentativa lê a decisão de quem ganhou); falha permanente de infraestrutura → DLQ e alerta. Erros
 * transientes de infraestrutura são relançados para o consumer contar como transiente e fazer retry com backoff.
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
    const providerId = message.actorProviderId ?? command.actorProviderId ?? command.submission.providerId;
    try {
      const output = await this.processWager.execute({
        actor: { providerId },
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

/** Um observer nunca pode mudar o outcome, seja lançando erro ou retornando promise rejeitada. */
const notify = (callback: () => unknown): void => {
  try {
    Promise.resolve(callback()).catch(() => undefined);
  } catch {
    // ver acima
  }
};
