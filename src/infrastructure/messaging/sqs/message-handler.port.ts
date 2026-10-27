export const DeadLetterReason = {
  INVALID_JSON: 'invalid_json',
  INVALID_SCHEMA: 'invalid_schema',
  /** Valid shape, forbidden content (e.g. kind OPENING from a provider). */
  CONTRACT_VIOLATION: 'contract_violation',
  INBOX_PAYLOAD_MISMATCH: 'inbox_payload_mismatch',
  PERMANENT_INFRASTRUCTURE: 'permanent_infrastructure',
} as const;

export type DeadLetterReason = (typeof DeadLetterReason)[keyof typeof DeadLetterReason];

export type MessageOutcome =
  | { readonly kind: 'ack' }
  /** Without `delayMs` the consumer picks the backoff from the receive count. */
  | { readonly kind: 'retry'; readonly delayMs?: number }
  | { readonly kind: 'dead-letter'; readonly reason: DeadLetterReason; readonly detail?: string };

export const MessageOutcome = {
  ack: (): MessageOutcome => ({ kind: 'ack' }),
  retry: (delayMs?: number): MessageOutcome => (delayMs === undefined ? { kind: 'retry' } : { kind: 'retry', delayMs }),
  deadLetter: (reason: DeadLetterReason, detail?: string): MessageOutcome =>
    detail === undefined ? { kind: 'dead-letter', reason } : { kind: 'dead-letter', reason, detail },
} as const;

export interface InboundMessage {
  /** JSON.parse of the SQS body. The handler validates its shape (schema errors → dead letter). */
  readonly body: unknown;
  readonly rawBody: string;
  /** SQS MessageId. The provider's own `messageId`, used by the inbox, lives inside `body`. */
  readonly sqsMessageId: string;
  /** ApproximateReceiveCount: 1 on the first delivery. */
  readonly receiveCount: number;
  readonly messageGroupId?: string;
  readonly sentAt?: Date;
}

/**
 * The pluggable unit of work of the SQS consumer (T09b plugs ProcessWagerTransaction in). It may return an
 * outcome or throw: thrown errors go through classifyMessageError. Acking happens only after it resolves,
 * so the handler must commit before returning `ack`. `signal` is aborted only when shutdown times out.
 */
export interface IMessageHandler {
  handle(message: InboundMessage, signal: AbortSignal): Promise<MessageOutcome>;
}
