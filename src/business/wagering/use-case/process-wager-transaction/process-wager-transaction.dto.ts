import type { FailureCode } from '../../../shared/error/failure-code';
import type { AuthenticatedProvider } from '../../../shared/port/provider-identity.port';
import type { MoneyProps } from '../../../shared/value-object/money';
import type { WagerKind } from '../../enum/wager-kind';
import type { WagerTransactionStatus } from '../../enum/wager-transaction-status';

export type WagerChannel = 'HTTP' | 'SQS';

/** Submissão crua, como chega no controller ou no consumer (quem valida é o use case). */
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
  /** Provider autenticado pelo transporte (token no HTTP, fila confiável no SQS). */
  readonly actor: AuthenticatedProvider;
  /** HTTP: o header Idempotency-Key. SQS: `data.idempotencyKey`. */
  readonly idempotencyKey: string;
  readonly payload: WagerSubmission;
  readonly source: WagerSource;
  readonly correlationId?: string;
}

export type DecidedStatus = Exclude<WagerTransactionStatus, 'PENDING'>;

/** Lido pelos adapters HTTP/SQS (status code, ack) e pelos decorators de métrica (status, kind, replay, channel). */
export interface ProcessWagerTransactionOutput {
  readonly transactionId: string;
  readonly kind: WagerKind;
  readonly status: DecidedStatus;
  readonly failureCode: FailureCode | null;
  /** Saldo visto na decisão, para PENDING_REFERENCE é o saldo da wallet no momento da resposta. */
  readonly balance: MoneyProps | null;
  readonly idempotentReplay: boolean;
  readonly channel: WagerChannel;
}
