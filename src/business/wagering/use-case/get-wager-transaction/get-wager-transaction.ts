import { InvalidRequestError } from '../../../shared/error/invalid-request-error';
import type { FailureCode } from '../../../shared/error/failure-code';
import type { IUseCase } from '../../../shared/use-case';
import type { MoneyProps } from '../../../shared/value-object/money';
import type { WagerTransaction } from '../../entity/wager-transaction';
import type { WagerKind } from '../../enum/wager-kind';
import type { WagerTransactionStatus } from '../../enum/wager-transaction-status';
import { WagerTransactionNotFoundError } from '../../error/wager-transaction-not-found-error';
import type { IWagerTransactionRepository } from '../../port/wager-transaction.repository.port';

export type GetWagerTransactionInput =
  | { readonly transactionId: string }
  | { readonly providerId: string; readonly externalTransactionId: string };

export interface WagerTransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: MoneyProps;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly balance: MoneyProps | null;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
}

const toView = (transaction: WagerTransaction): WagerTransactionView => ({
  transactionId: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money.toProps(),
  status: transaction.status,
  failureCode: transaction.failureCode ?? null,
  referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
  referenceTransactionId: transaction.referenceTransactionId ?? null,
  balance: transaction.observedBalance?.toProps() ?? null,
  attempts: transaction.attempts,
  nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
  createdAt: transaction.createdAt.toISOString(),
  processedAt: transaction.processedAt?.toISOString() ?? null,
});

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** Pelo id interno, ou pelo id do próprio provider (GET /providers/:providerId/wagering/transactions/:externalId). */
export class GetWagerTransaction implements IUseCase<GetWagerTransactionInput, WagerTransactionView> {
  constructor(private readonly transactions: Pick<IWagerTransactionRepository, 'findById' | 'findByExternalId'>) {}

  async execute(input: GetWagerTransactionInput): Promise<WagerTransactionView> {
    if ('transactionId' in input) {
      if (isBlank(input.transactionId)) throw new InvalidRequestError('transactionId', 'is required');
      const transaction = await this.transactions.findById(input.transactionId);
      if (transaction === null) throw new WagerTransactionNotFoundError(input.transactionId);
      return toView(transaction);
    }
    if (isBlank(input.providerId)) throw new InvalidRequestError('providerId', 'is required');
    if (isBlank(input.externalTransactionId)) throw new InvalidRequestError('externalTransactionId', 'is required');
    const transaction = await this.transactions.findByExternalId(input.providerId, input.externalTransactionId);
    if (transaction === null) {
      throw new WagerTransactionNotFoundError(`${input.providerId}/${input.externalTransactionId}`);
    }
    return toView(transaction);
  }
}
