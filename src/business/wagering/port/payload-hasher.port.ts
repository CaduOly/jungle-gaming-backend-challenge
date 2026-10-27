import type { MoneyProps } from '../../shared/value-object/money';
import type { WagerKind } from '../enum/wager-kind';

/** Normalized submission fields that define "the same request" for idempotency. */
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

export interface IPayloadHasher {
  hash(payload: WagerPayload): string;
}
