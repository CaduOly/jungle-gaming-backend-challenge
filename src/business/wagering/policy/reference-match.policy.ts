import { FailureCode } from '../../shared/error/failure-code';
import type { WagerTransaction } from '../entity/wager-transaction';

export type ReferenceMatchFailure = typeof FailureCode.REFERENCE_MISMATCH | typeof FailureCode.CURRENCY_MISMATCH;

/** CHALLENGE.md §7 regra 2: a referência tem que ter o mesmo provider, player, wallet, round e currency. */
export const checkReferenceMatch = (
  transaction: WagerTransaction,
  reference: WagerTransaction,
): ReferenceMatchFailure | null => {
  const sameOwner =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.roundId === transaction.roundId;
  if (!sameOwner) return FailureCode.REFERENCE_MISMATCH;
  if (reference.money.currency !== transaction.money.currency) return FailureCode.CURRENCY_MISMATCH;
  return null;
};
