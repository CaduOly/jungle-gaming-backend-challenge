import type { MoneyProps } from '../../shared/value-object/money';
import type { WagerKind } from '../enum/wager-kind';

/** Campos normalizados da submissão que definem "a mesma requisição" para a idempotência. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

/** O que uma mensagem da fila pede: os campos de negócio mais a idempotency key que vem em `data`. */
export interface WagerMessagePayload extends WagerPayload {
  idempotencyKey: string;
}

/** JSON canônico (keys ordenadas, sem espaço) que o adapter passa no sha256. */
export interface IPayloadHasher {
  hash(payload: WagerPayload): string;
  /** Hash do inbox: diferencia uma reentrega (mesmo hash) de outra mensagem reaproveitando o messageId. */
  hashMessage(message: WagerMessagePayload): string;
}
