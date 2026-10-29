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

/** What one queue message asks for: the business fields plus the idempotency key it carries in `data`. */
export interface WagerMessagePayload extends WagerPayload {
  idempotencyKey: string;
}

/** Canonical JSON (sorted keys, no whitespace) hashed with sha256 by the adapter. */
export interface IPayloadHasher {
  hash(payload: WagerPayload): string;
  /** Inbox hash: tells a redelivery (same hash) from a different message reusing the messageId. */
  hashMessage(message: WagerMessagePayload): string;
}
