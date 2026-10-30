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
 * Valor monetário exato e nunca negativo, em centavos (escala 2).
 * Input em qualquer outro formato é rejeitado, já que não existe política de arredondamento.
 */
export class Money {
  readonly #cents: bigint;
  /**
   * String decimal normalizada ("25.00"), derivada dos centavos. A aritmética nunca lê esse campo, ele é público
   * para a igualdade estrutural (spread, `toEqual`) enxergar o valor e não só a moeda.
   */
  readonly amount: string;

  private constructor(
    cents: bigint,
    readonly currency: string,
  ) {
    if (cents < 0n) throw new NegativeMoneyError();
    if (cents > MAX_CENTS) throw new MoneyOverflowError();
    this.#cents = cents;
    this.amount = Money.format(cents);
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;
    if (!Money.isValidAmount(amount)) throw new InvalidMoneyAmountError(amount);
    return new Money(BigInt(amount.replace('.', '')), Money.assertCurrency(currency));
  }

  /** A regra de formato do Money.from só para o amount, para a borda conseguir reportar separado da moeda. */
  static isValidAmount(amount: unknown): amount is string {
    return typeof amount === 'string' && AMOUNT_PATTERN.test(amount);
  }

  static isValidCurrency(currency: unknown): currency is string {
    return typeof currency === 'string' && CURRENCY_PATTERN.test(currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#cents + other.#cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#cents - other.#cents, this.currency);
  }

  isZero(): boolean {
    return this.#cents === 0n;
  }

  isPositive(): boolean {
    return this.#cents > 0n;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#cents > other.#cents;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#cents >= other.#cents;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#cents < other.#cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.#cents === other.#cents;
  }

  toProps(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toJSON(): MoneyProps {
    return this.toProps();
  }

  toString(): string {
    return Money.format(this.#cents);
  }

  private static format(cents: bigint): string {
    const units = cents / CENTS_PER_UNIT;
    const fraction = (cents % CENTS_PER_UNIT).toString().padStart(2, '0');
    return `${units}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private static assertCurrency(currency: unknown): string {
    if (!Money.isValidCurrency(currency)) throw new InvalidCurrencyError(currency);
    return currency;
  }
}
