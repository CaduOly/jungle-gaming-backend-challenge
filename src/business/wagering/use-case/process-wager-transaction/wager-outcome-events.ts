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
  /** A wallet depois da decisão (já debitada ou creditada quando a transação moveu dinheiro). */
  readonly wallet: Wallet;
  readonly entry: WalletLedgerEntry | null;
}

export interface OutcomeEventContext {
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

/**
 * Transforma uma transação decidida nos integration events do CHALLENGE.md §11:
 * PROCESSED → Processed (+ WalletBalanceChanged quando moveu dinheiro), REJECTED → Rejected,
 * PENDING_REFERENCE → PendingReference. FAILED é um estado interno, auditável e sem evento.
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
