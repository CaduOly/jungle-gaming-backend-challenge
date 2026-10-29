import type { EventContext } from '../../messaging/event/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '../../messaging/event/integration-event';
import { InvalidTransactionStateError } from '../../shared/error/invalid-transaction-state-error';
import type { Wallet } from '../../wallet/entity/wallet';
import type { WagerTransaction } from '../entity/wager-transaction';
import { WagerTransactionStatus } from '../enum/wager-transaction-status';
import { describeWagerTransaction, type WagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  readonly processedAt: string;
}

/** Any applied transaction, LOSS included. Grouped by wallet so it orders with the balance stream. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  readonly aggregateType = 'Wallet';

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, wallet: Wallet, context: EventContext): WagerTransactionProcessed {
    const processedAt = transaction.processedAt;
    if (transaction.status !== WagerTransactionStatus.PROCESSED || processedAt === undefined) {
      throw new InvalidTransactionStateError(transaction.status, WagerTransactionStatus.PROCESSED);
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: { ...describeWagerTransaction(transaction, wallet), processedAt: processedAt.toISOString() },
    });
  }
}
