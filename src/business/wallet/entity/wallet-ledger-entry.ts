import { CurrencyMismatchError } from '../../shared/error/currency-mismatch-error';
import type { Money } from '../../shared/value-object/money';
import { LedgerDirection } from '../enum/ledger-direction';
import { isDirectionAllowedFor, LedgerEntryType } from '../enum/ledger-entry-type';
import { InvalidLedgerEntryError } from '../error/invalid-ledger-entry-error';

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  entryType: LedgerEntryType;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  seq: bigint | undefined;
}

/**
 * Uma movimentação de saldo de uma wallet. Uma transação gera no máximo uma entry, então
 * `transactionId` identifica a entry, e a entry de OPENING aponta para a transação interna
 * de OPENING. O `seq` é atribuído pela persistência e é a base do cursor do ledger.
 */
export class WalletLedgerEntry {
  private constructor(private readonly state: Readonly<LedgerEntryState>) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      Object.freeze({ ...props, createdAt: new Date(props.createdAt), seq: undefined }),
    );
    entry.validate();
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(Object.freeze({ ...state, createdAt: new Date(state.createdAt) }));
  }

  get walletId(): string {
    return this.state.walletId;
  }

  get transactionId(): string {
    return this.state.transactionId;
  }

  get direction(): LedgerDirection {
    return this.state.direction;
  }

  get entryType(): LedgerEntryType {
    return this.state.entryType;
  }

  get amount(): Money {
    return this.state.amount;
  }

  get balanceBefore(): Money {
    return this.state.balanceBefore;
  }

  get balanceAfter(): Money {
    return this.state.balanceAfter;
  }

  get walletVersion(): number {
    return this.state.walletVersion;
  }

  get currency(): string {
    return this.state.amount.currency;
  }

  get createdAt(): Date {
    return new Date(this.state.createdAt.getTime());
  }

  get seq(): bigint | undefined {
    return this.state.seq;
  }

  isCredit(): boolean {
    return this.state.direction === LedgerDirection.CREDIT;
  }

  isBalanced(): boolean {
    const { balanceBefore, balanceAfter, amount } = this.state;
    if (amount.currency !== balanceBefore.currency || amount.currency !== balanceAfter.currency) return false;
    return this.isCredit()
      ? balanceAfter.isGreaterThanOrEqual(balanceBefore) && balanceAfter.subtract(balanceBefore).equals(amount)
      : balanceBefore.isGreaterThanOrEqual(balanceAfter) && balanceBefore.subtract(balanceAfter).equals(amount);
  }

  withSeq(seq: bigint): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({ ...this.state, seq });
  }

  toState(): LedgerEntryState {
    return { ...this.state, createdAt: this.createdAt };
  }

  private validate(): void {
    const { walletId, transactionId, direction, entryType, amount, balanceBefore, balanceAfter, walletVersion } =
      this.state;
    if (walletId === '') throw new InvalidLedgerEntryError('walletId is required');
    if (transactionId === '') throw new InvalidLedgerEntryError('transactionId is required');
    if (!Number.isSafeInteger(walletVersion) || walletVersion < 1) {
      throw new InvalidLedgerEntryError(`walletVersion must be a positive integer, got ${walletVersion}`);
    }
    if (!isDirectionAllowedFor(entryType, direction)) {
      throw new InvalidLedgerEntryError(`${entryType} cannot be a ${direction}`);
    }
    if (entryType === LedgerEntryType.OPENING && (walletVersion !== 1 || !balanceBefore.isZero())) {
      throw new InvalidLedgerEntryError('OPENING must be the first entry: walletVersion 1 from a zero balance');
    }
    for (const money of [balanceBefore, balanceAfter]) {
      if (money.currency !== amount.currency) throw new CurrencyMismatchError(amount.currency, money.currency);
    }
    if (!amount.isPositive()) throw new InvalidLedgerEntryError('amount must be greater than zero');
    if (!this.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `${balanceBefore} ${direction} ${amount} does not result in ${balanceAfter}`,
      );
    }
  }
}
