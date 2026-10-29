import type { IntegrationEvent } from '../../../messaging/event/integration-event';
import { InvalidTransactionStateError } from '../../../shared/error/invalid-transaction-state-error';
import type { IIdGenerator } from '../../../shared/port/id-generator.port';
import type { Wallet } from '../../../wallet/entity/wallet';
import type { WalletLedgerEntry } from '../../../wallet/entity/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../../wallet/event/wallet-balance-changed.event';
import type { WagerTransaction } from '../../entity/wager-transaction';
import { WagerTransactionStatus } from '../../enum/wager-transaction-status';
import { WagerTransactionPendingReference } from '../../event/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../../event/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../../event/wager-transaction-rejected.event';

export interface WagerOutcome {
  readonly transaction: WagerTransaction;
  /** The wallet after the decision (already debited or credited when the transaction moved money). */
  readonly wallet: Wallet;
  readonly entry: WalletLedgerEntry | null;
}

export interface OutcomeEventContext {
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

/**
 * Turns a decided transaction into the integration events of CHALLENGE.md §11:
 * PROCESSED → Processed (+ WalletBalanceChanged when it moved money), REJECTED → Rejected,
 * PENDING_REFERENCE → PendingReference. FAILED is an internal, auditable state with no event.
 */
export class WagerOutcomeEvents {
  constructor(private readonly ids: IIdGenerator) {}

  toEvents({ transaction, wallet, entry }: WagerOutcome, context: OutcomeEventContext): IntegrationEvent<unknown>[] {
    const eventContext = () => ({ ...context, eventId: this.ids.generate() });
    switch (transaction.status) {
      case WagerTransactionStatus.PROCESSED: {
        const processed = WagerTransactionProcessed.from(transaction, wallet, eventContext());
        return entry === null ? [processed] : [processed, WalletBalanceChanged.from(wallet, entry, eventContext())];
      }
      case WagerTransactionStatus.REJECTED:
        return [WagerTransactionRejected.from(transaction, wallet, eventContext())];
      case WagerTransactionStatus.PENDING_REFERENCE:
        return [WagerTransactionPendingReference.from(transaction, wallet, eventContext())];
      case WagerTransactionStatus.FAILED:
        return [];
      case WagerTransactionStatus.PENDING:
        throw new InvalidTransactionStateError(transaction.status, 'a decided status');
    }
  }
}
