export const DeadLetterReason = {
  INVALID_JSON: 'invalid_json',
  INVALID_SCHEMA: 'invalid_schema',
  /** Formato válido, conteúdo proibido (ex. kind OPENING vindo de um provider). */
  CONTRACT_VIOLATION: 'contract_violation',
  INBOX_PAYLOAD_MISMATCH: 'inbox_payload_mismatch',
  PERMANENT_INFRASTRUCTURE: 'permanent_infrastructure',
  /** Ainda falhando depois de todas as tentativas in-process do último receive permitido pelo maxReceiveCount. */
  RETRIES_EXHAUSTED: 'retries_exhausted',
} as const;

export type DeadLetterReason = (typeof DeadLetterReason)[keyof typeof DeadLetterReason];

export type MessageOutcome =
  | { readonly kind: 'ack' }
  /** Sem `delayMs` o consumer escolhe o backoff pelo receive count. */
  | { readonly kind: 'retry'; readonly delayMs?: number }
  | { readonly kind: 'dead-letter'; readonly reason: DeadLetterReason; readonly detail?: string };

export const MessageOutcome = {
  ack: (): MessageOutcome => ({ kind: 'ack' }),
  retry: (delayMs?: number): MessageOutcome => (delayMs === undefined ? { kind: 'retry' } : { kind: 'retry', delayMs }),
  deadLetter: (reason: DeadLetterReason, detail?: string): MessageOutcome =>
    detail === undefined ? { kind: 'dead-letter', reason } : { kind: 'dead-letter', reason, detail },
} as const;

export interface InboundMessage {
  /** JSON.parse do body do SQS. O handler valida o formato (erro de schema → dead letter). */
  readonly body: unknown;
  readonly rawBody: string;
  /** MessageId do SQS. O `messageId` do próprio provider, usado pelo inbox, fica dentro do `body`. */
  readonly sqsMessageId: string;
  /** ApproximateReceiveCount: 1 na primeira entrega. */
  readonly receiveCount: number;
  readonly messageGroupId?: string;
  readonly sentAt?: Date;
  readonly actorProviderId?: string;
}

/**
 * A unidade de trabalho plugável do consumer SQS (o wager command handler pluga o ProcessWagerTransaction). Pode
 * retornar um outcome ou lançar erro, e erro lançado passa pelo classifyMessageError. O ack só acontece depois que
 * ele resolve, então o handler tem que commitar antes de retornar `ack`. O `signal` só é abortado quando o shutdown
 * dá timeout.
 */
export interface IMessageHandler {
  handle(message: InboundMessage, signal: AbortSignal): Promise<MessageOutcome>;
}
