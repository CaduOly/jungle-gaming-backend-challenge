import { BusinessRuleError } from '../../shared/error/business-rule-error';
import { FailureCode } from '../../shared/error/failure-code';
import { InvalidTransactionStateError } from '../../shared/error/invalid-transaction-state-error';
import { MoneyOverflowError } from '../../shared/error/money-overflow-error';
import type { Wallet } from '../../wallet/entity/wallet';
import type { WalletLedgerEntry } from '../../wallet/entity/wallet-ledger-entry';
import type { WagerTransaction } from '../entity/wager-transaction';
import { WagerKind } from '../enum/wager-kind';
import { WagerTransactionStatus } from '../enum/wager-transaction-status';
import { InvalidWagerTransactionError } from '../error/invalid-wager-transaction-error';

export interface SettleCommand {
  transaction: WagerTransaction;
  /** A wallet da transação, já com lock pego por quem chamou. */
  wallet: Wallet;
  /** A referência resolvida, quando a transação tem uma. */
  reference: WagerTransaction | null;
  at: Date;
}

export type SettlementOutcome =
  | { type: 'Processed'; entry: WalletLedgerEntry | null }
  | { type: 'Rejected'; code: FailureCode };

type CreditKind = typeof WagerKind.WIN | typeof WagerKind.REFUND | typeof WagerKind.ROLLBACK;
type DebitKind = typeof WagerKind.BET | typeof WagerKind.ROLLBACK;

/**
 * Aplica uma transação resolvida na wallet e leva a transação para PROCESSED ou REJECTED, gravando o saldo
 * visto depois da decisão. Rejeição de negócio nunca mexe na wallet. Um crédito além do máximo de Money é uma
 * delas (BALANCE_LIMIT_EXCEEDED), já que a wallet calcula o saldo novo antes de mudar qualquer coisa, então ela
 * fica exatamente como estava.
 */
export class WagerSettlement {
  settle({ transaction, wallet, reference, at }: SettleCommand): SettlementOutcome {
    if (transaction.isTerminal()) {
      throw new InvalidTransactionStateError(transaction.status, WagerTransactionStatus.PROCESSED);
    }
    if (transaction.isOpening) throw new InvalidWagerTransactionError('OPENING is settled by Wallet.open');
    if (wallet.id !== transaction.walletId) {
      throw new InvalidWagerTransactionError(`wallet ${wallet.id} is not ${transaction.walletId}`);
    }
    if (reference !== null) transaction.attachReference(reference);

    try {
      wallet.assertOwnedBy(transaction.playerId);
      if (transaction.money.currency !== wallet.currency) {
        return this.reject(transaction, wallet, FailureCode.CURRENCY_MISMATCH, at);
      }
      const entry = transaction.affectsBalance ? this.move(transaction, wallet, reference, at) : null;
      transaction.markProcessed(wallet.balance, at);
      return { type: 'Processed', entry };
    } catch (error) {
      if (error instanceof BusinessRuleError) return this.reject(transaction, wallet, error.failureCode, at);
      if (error instanceof MoneyOverflowError) return this.reject(transaction, wallet, FailureCode.BALANCE_LIMIT_EXCEEDED, at);
      throw error;
    }
  }

  private move(
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | null,
    at: Date,
  ): WalletLedgerEntry {
    const movement = { transactionId: transaction.id, amount: transaction.money, at };
    if (transaction.ledgerDirectionFor(reference ?? undefined) === 'CREDIT') {
      return wallet.credit({ ...movement, entryType: transaction.kind as CreditKind });
    }
    return wallet.debit({
      ...movement,
      entryType: transaction.kind as DebitKind,
      insufficientFundsCode:
        transaction.kind === WagerKind.BET ? FailureCode.INSUFFICIENT_FUNDS : FailureCode.REVERSAL_INSUFFICIENT_FUNDS,
    });
  }

  private reject(transaction: WagerTransaction, wallet: Wallet, code: FailureCode, at: Date): SettlementOutcome {
    transaction.reject(code, wallet.balance, at);
    return { type: 'Rejected', code };
  }
}
