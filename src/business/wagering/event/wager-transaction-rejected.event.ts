import type { EventContext } from '../../messaging/event/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '../../messaging/event/integration-event';
import type { FailureCode } from '../../shared/error/failure-code';
import { InvalidTransactionStateError } from '../../shared/error/invalid-transaction-state-error';
import type { Wallet } from '../../wallet/entity/wallet';
import type { WagerTransaction } from '../entity/wager-transaction';
import { WagerTransactionStatus } from '../enum/wager-transaction-status';
import { describeWagerTransaction, type WagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  readonly failureCode: FailureCode;
  readonly rejectedAt: string;
}

/** Uma regra de negócio rejeitou a transação, o saldo não foi alterado. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  readonly aggregateType = 'Wallet';

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, wallet: Wallet, context: EventContext): WagerTransactionRejected {
    const { failureCode, processedAt } = transaction;
    if (transaction.status !== WagerTransactionStatus.REJECTED || failureCode === undefined || processedAt === undefined) {
      throw new InvalidTransactionStateError(transaction.status, WagerTransactionStatus.REJECTED);
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.walletId,
      data: { ...describeWagerTransaction(transaction, wallet), failureCode, rejectedAt: processedAt.toISOString() },
    });
  }
}
