import { FailureCode } from '../../shared/error/failure-code';
import type { WagerTransaction } from '../entity/wager-transaction';
import { WagerKind } from '../enum/wager-kind';

export type ReversalFailure =
  | typeof FailureCode.INVALID_REFERENCE_KIND
  | typeof FailureCode.ALREADY_REVERSED
  | typeof FailureCode.AMOUNT_MISMATCH;

const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerKind, readonly WagerKind[]>>> = {
  WIN: [WagerKind.BET],
  LOSS: [WagerKind.BET],
  REFUND: [WagerKind.BET],
  ROLLBACK: [WagerKind.BET, WagerKind.WIN, WagerKind.REFUND],
};

export const isReferenceKindAllowed = (kind: WagerKind, referenceKind: WagerKind): boolean =>
  ALLOWED_REFERENCE_KINDS[kind]?.includes(referenceKind) ?? false;

/**
 * REFUND reverte um BET, ROLLBACK reverte um BET, WIN ou REFUND (então dá para fazer rollback de um refund).
 * Cada referência é revertida uma vez só no total, por REFUND ou ROLLBACK, e só pelo valor inteiro.
 */
export const checkReversal = (
  reversal: WagerTransaction,
  reference: WagerTransaction,
  referenceAlreadyReversed: boolean,
): ReversalFailure | null => {
  if (!isReferenceKindAllowed(reversal.kind, reference.kind)) return FailureCode.INVALID_REFERENCE_KIND;
  if (referenceAlreadyReversed) return FailureCode.ALREADY_REVERSED;
  if (!reversal.money.equals(reference.money)) return FailureCode.AMOUNT_MISMATCH;
  return null;
};
