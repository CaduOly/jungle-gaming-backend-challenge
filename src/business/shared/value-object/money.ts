import { CurrencyMismatchError } from '../error/currency-mismatch-error';
import { InvalidCurrencyError } from '../error/invalid-currency-error';
import { InvalidMoneyAmountError } from '../error/invalid-money-amount-error';
import { MoneyOverflowError } from '../error/money-overflow-error';
import { NegativeMoneyError } from '../error/negative-money-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CENTS_PER_UNIT = 100n;
const MAX_CENTS = 99_999_999_999_999_999_999n;

/**
 * Exact monetary amount in minor units (cents, scale 2).
 * Input with any other format is rejected: there is no rounding policy.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) throw new InvalidMoneyAmountError(amount);
    return new Money(BigInt(amount.replace('.', '')), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withCents(this.cents + other.cents);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.cents - other.cents;
    if (result < 0n) throw new NegativeMoneyError();
    return this.withCents(result);
  }

  /**
   * @internal Signed deltas only (e.g. ledger bookkeeping). Never expose a negative Money in a contract.
   */
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents > other.cents;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents >= other.cents;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toProps(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toJSON(): MoneyProps {
    return this.toProps();
  }

  toString(): string {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const units = absolute / CENTS_PER_UNIT;
    const fraction = (absolute % CENTS_PER_UNIT).toString().padStart(2, '0');
    return `${this.cents < 0n ? '-' : ''}${units}.${fraction}`;
  }

  private withCents(cents: bigint): Money {
    if (cents > MAX_CENTS || cents < -MAX_CENTS) throw new MoneyOverflowError();
    return new Money(cents, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) throw new InvalidCurrencyError(currency);
    return currency;
  }
}
