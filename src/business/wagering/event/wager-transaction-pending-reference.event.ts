import type { EventContext } from '../../messaging/event/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '../../messaging/event/integration-event';
import { InvalidTransactionStateError } from '../../shared/error/invalid-transaction-state-error';
import type { Wallet } from '../../wallet/entity/wallet';
import type { WagerTransaction } from '../entity/wager-transaction';
import { WagerTransactionStatus } from '../enum/wager-transaction-status';
import { describeWagerTransaction, type WagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  readonly referenceExternalTransactionId: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
}

/** The reference is missing (or still pending itself); the pending-reference worker retries it later. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  readonly aggregateType = 'Wallet';

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    context: EventContext,
  ): WagerTransactionPendingReference {
    const { referenceExternalTransactionId, nextAttemptAt } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.PENDING_REFERENCE ||
      referenceExternalTransactionId === undefined ||
      nextAttemptAt === undefined
    ) {
      throw new InvalidTransactionStateError(transaction.status, WagerTransactionStatus.PENDING_REFERENCE);
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...describeWagerTransaction(transaction, wallet),
        referenceExternalTransactionId,
        attempts: transaction.attempts,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
    });
  }
}
