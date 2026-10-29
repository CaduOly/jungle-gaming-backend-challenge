import type { FailureCode } from '../../../shared/error/failure-code';
import type { AuthenticatedProvider } from '../../../shared/port/provider-identity.port';
import type { MoneyProps } from '../../../shared/value-object/money';
import type { WagerKind } from '../../enum/wager-kind';
import type { WagerTransactionStatus } from '../../enum/wager-transaction-status';

export type WagerChannel = 'HTTP' | 'SQS';

/** Raw submission, as received by the controller or the consumer (validated by the use case). */
export interface WagerSubmission {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | null;
}

export type WagerSource =
  | { readonly channel: 'HTTP' }
  | { readonly channel: 'SQS'; readonly consumerName: string; readonly messageId: string };

export interface ProcessWagerTransactionInput {
  /** Provider authenticated by the transport (token on HTTP, trusted queue on SQS). */
  readonly actor: AuthenticatedProvider;
  /** HTTP: the Idempotency-Key header. SQS: `data.idempotencyKey`. */
  readonly idempotencyKey: string;
  readonly payload: WagerSubmission;
  readonly source: WagerSource;
  readonly correlationId?: string;
}

export type DecidedStatus = Exclude<WagerTransactionStatus, 'PENDING'>;

/** Read by the HTTP/SQS adapters (status code, ack) and by the metric decorators (status, kind, replay, channel). */
export interface ProcessWagerTransactionOutput {
  readonly transactionId: string;
  readonly kind: WagerKind;
  readonly status: DecidedStatus;
  readonly failureCode: FailureCode | null;
  /** Balance observed at the decision; for PENDING_REFERENCE, the wallet balance when it was answered. */
  readonly balance: MoneyProps | null;
  readonly idempotentReplay: boolean;
  readonly channel: WagerChannel;
}
