import { CurrencyMismatchError } from '../../shared/error/currency-mismatch-error';
import { Money } from '../../shared/value-object/money';
import { LedgerDirection } from '../enum/ledger-direction';
import { LedgerEntryType } from '../enum/ledger-entry-type';
import { type InsufficientFundsCode, InsufficientFundsError } from '../error/insufficient-funds-error';
import { InvalidLedgerEntryError } from '../error/invalid-ledger-entry-error';
import { WalletPlayerMismatchError } from '../error/wallet-player-mismatch-error';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Transação interna de OPENING, só é obrigatória quando o saldo inicial é positivo. */
  openingTransactionId?: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | null;
}

interface Movement {
  transactionId: string;
  amount: Money;
  at: Date;
}

export interface CreditProps extends Movement {
  entryType: typeof LedgerEntryType.WIN | typeof LedgerEntryType.REFUND | typeof LedgerEntryType.ROLLBACK;
}

export interface DebitProps extends Movement {
  entryType: typeof LedgerEntryType.BET | typeof LedgerEntryType.ROLLBACK;
  insufficientFundsCode: InsufficientFundsCode;
}

const INITIAL_VERSION = 1;

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * O saldo inicial é gravado direto na versão 1 (sem passar pelo `credit`),
   * e quando é positivo ele vem espelhado na entry de OPENING retornada.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, openingTransactionId, at } = props;
    const wallet = new Wallet(id, playerId, initialBalance, INITIAL_VERSION, new Date(at), new Date(at));
    if (initialBalance.isZero()) return { wallet, openingEntry: null };
    if (openingTransactionId === undefined) {
      throw new InvalidLedgerEntryError('an opening balance requires the OPENING transaction id');
    }
    const openingEntry = WalletLedgerEntry.create({
      walletId: id,
      transactionId: openingTransactionId,
      direction: LedgerDirection.CREDIT,
      entryType: LedgerEntryType.OPENING,
      amount: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: INITIAL_VERSION,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get currency(): string {
    return this._balance.currency;
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  isOwnedBy(playerId: string): boolean {
    return this.playerId === playerId;
  }

  assertOwnedBy(playerId: string): void {
    if (!this.isOwnedBy(playerId)) throw new WalletPlayerMismatchError(this.id, playerId);
  }

  credit(props: CreditProps): WalletLedgerEntry {
    this.assertSameCurrency(props.amount);
    return this.apply(LedgerDirection.CREDIT, props, this._balance.add(props.amount));
  }

  /** `insufficientFundsCode` deixa quem chama diferenciar uma aposta comum de um reversal (CHALLENGE.md §7, regra 9). */
  debit(props: DebitProps): WalletLedgerEntry {
    this.assertSameCurrency(props.amount);
    if (props.amount.isGreaterThan(this._balance)) {
      throw new InsufficientFundsError(props.insufficientFundsCode, this.id);
    }
    return this.apply(LedgerDirection.DEBIT, props, this._balance.subtract(props.amount));
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  private apply(
    direction: LedgerDirection,
    props: CreditProps | DebitProps,
    balanceAfter: Money,
  ): WalletLedgerEntry {
    if ((props.entryType as LedgerEntryType) === LedgerEntryType.OPENING) {
      throw new InvalidLedgerEntryError('OPENING is only written by Wallet.open');
    }
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      entryType: props.entryType,
      amount: props.amount,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = new Date(props.at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
