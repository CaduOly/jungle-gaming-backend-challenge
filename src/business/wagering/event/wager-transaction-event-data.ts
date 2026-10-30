import type { FailureCode } from '../../shared/error/failure-code';
import type { MoneyProps } from '../../shared/value-object/money';
import type { Wallet } from '../../wallet/entity/wallet';
import type { WagerTransaction } from '../entity/wager-transaction';
import type { WagerKind } from '../enum/wager-kind';
import type { WagerTransactionStatus } from '../enum/wager-transaction-status';

/** Descrição comum de uma wager transaction, só em JSON, que vai em todo evento de wagering. */
export interface WagerTransactionEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: MoneyProps;
  readonly status: WagerTransactionStatus;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly failureCode: FailureCode | null;
  /** Saldo visto quando a decisão foi tomada, para uma transação pendente é o saldo naquele momento. */
  readonly balance: MoneyProps;
  /** Versão da wallet logo depois da decisão, para os eventos de wagering ficarem ordenados com o WalletBalanceChanged. */
  readonly walletVersion: number;
}

export const describeWagerTransaction = (
  transaction: WagerTransaction,
  wallet: Wallet,
): WagerTransactionEventData => ({
  transactionId: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  idempotencyKey: transaction.idempotencyKey,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money.toProps(),
  status: transaction.status,
  referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
  referenceTransactionId: transaction.referenceTransactionId ?? null,
  failureCode: transaction.failureCode ?? null,
  balance: (transaction.observedBalance ?? wallet.balance).toProps(),
  walletVersion: wallet.version,
});
