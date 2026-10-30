import { FailureCode } from '../../shared/error/failure-code';
import type { WagerTransaction } from '../entity/wager-transaction';
import { WagerTransactionStatus } from '../enum/wager-transaction-status';
import type { IWagerTransactionReader } from '../port/wager-transaction.repository.port';
import { checkReferenceMatch } from '../policy/reference-match.policy';
import { checkReversal, isReferenceKindAllowed } from '../policy/reversal.policy';

export type ReferenceResolution =
  /** `reference` é null quando a transação não referencia nada. */
  | { type: 'Resolved'; reference: WagerTransaction | null }
  | { type: 'Missing' }
  | { type: 'StillPending'; reference: WagerTransaction }
  | { type: 'Rejected'; code: FailureCode; reference: WagerTransaction };

const NOT_PROCESSED: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.REJECTED,
  WagerTransactionStatus.FAILED,
]);

/**
 * Busca a transação referenciada por (provider, external id) e aplica as policies de referência, checando
 * ownership (player, wallet, round, currency) antes de qualquer coisa que dependa do status da referência.
 * Se a referência não existe (WIN incluído) ou ainda espera a própria referência, a dependente fica
 * pendente, e se ela está REJECTED/FAILED a dependente é rejeitada com REFERENCE_NOT_PROCESSED.
 */
export class ReferenceResolver {
  constructor(private readonly transactions: Pick<IWagerTransactionReader, 'findByExternalId' | 'isReversed'>) {}

  async resolve(transaction: WagerTransaction): Promise<ReferenceResolution> {
    const externalId = transaction.referenceExternalTransactionId;
    if (externalId === undefined) return { type: 'Resolved', reference: null };

    const reference = await this.transactions.findByExternalId(transaction.providerId, externalId);
    if (reference === null) return { type: 'Missing' };

    // Ownership primeiro, senão o status da transação de outro player (ou round) vaza pelo código de erro.
    const mismatch = checkReferenceMatch(transaction, reference);
    if (mismatch !== null) return { type: 'Rejected', code: mismatch, reference };

    if (NOT_PROCESSED.has(reference.status)) {
      return { type: 'Rejected', code: FailureCode.REFERENCE_NOT_PROCESSED, reference };
    }
    if (reference.status !== WagerTransactionStatus.PROCESSED) return { type: 'StillPending', reference };

    if (!transaction.isReversal) {
      return isReferenceKindAllowed(transaction.kind, reference.kind)
        ? { type: 'Resolved', reference }
        : { type: 'Rejected', code: FailureCode.INVALID_REFERENCE_KIND, reference };
    }

    const alreadyReversed = await this.transactions.isReversed(reference.id);
    const reversalFailure = checkReversal(transaction, reference, alreadyReversed);
    return reversalFailure === null
      ? { type: 'Resolved', reference }
      : { type: 'Rejected', code: reversalFailure, reference };
  }
}
