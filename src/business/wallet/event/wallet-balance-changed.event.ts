import type { EventContext } from '../../messaging/event/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '../../messaging/event/integration-event';
import type { MoneyProps } from '../../shared/value-object/money';
import type { Wallet } from '../entity/wallet';
import type { WalletLedgerEntry } from '../entity/wallet-ledger-entry';
import type { LedgerDirection } from '../enum/ledger-direction';
import type { LedgerEntryType } from '../enum/ledger-entry-type';
import { InvalidLedgerEntryError } from '../error/invalid-ledger-entry-error';

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly playerId: string;
  readonly transactionId: string;
  readonly entryType: LedgerEntryType;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  /** Consumers order and dedupe the balance stream of a wallet by this version. */
  readonly walletVersion: number;
}

/** Emitted only when the balance moves, OPENING included; the aggregate (and FIFO group) is the wallet. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  readonly aggregateType = 'Wallet';

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidLedgerEntryError(`entry of wallet ${entry.walletId} cannot describe wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        transactionId: entry.transactionId,
        entryType: entry.entryType,
        direction: entry.direction,
        money: entry.amount.toProps(),
        balanceBefore: entry.balanceBefore.toProps(),
        balanceAfter: entry.balanceAfter.toProps(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
