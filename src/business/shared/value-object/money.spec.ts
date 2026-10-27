import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError } from '../error/currency-mismatch-error';
import { FailureCode } from '../error/failure-code';
import { InvalidCurrencyError } from '../error/invalid-currency-error';
import { InvalidMoneyAmountError } from '../error/invalid-money-amount-error';
import { MoneyOverflowError } from '../error/money-overflow-error';
import { NegativeMoneyError } from '../error/negative-money-error';
import { Money, type MoneyProps } from './money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const MAX = '999999999999999999.99';

describe('Money', () => {
  describe('from', () => {
    it.each(['0.00', '0.01', '0.10', '1.00', '25.00', '25.50', '100.99', MAX])('accepts %p and round-trips it', (amount) => {
      const money = brl(amount);
      expect(money.toString()).toBe(amount);
      expect(money.amount).toBe(amount);
      expect(money.amount).toBe(money.toString());
      expect(money.toProps()).toEqual({ amount, currency: 'BRL' });
      expect(money.currency).toBe('BRL');
    });

    it.each([
      '1.',
      '.5',
      '+1',
      ' 1',
      '1.00 ',
      '1.00\n',
      '-0.00',
      '-1.00',
      '1e2',
      '1.0e2',
      '25.5',
      '25',
      '25.000',
      '',
      '01.00',
      '00.00',
      '1,00',
      'NaN',
      'Infinity',
      '0x10',
      '1_000.00',
      '１.00',
      '1000000000000000000.00',
    ])('rejects amount %p', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyAmountError);
    });

    it.each([25, 25.5, Number.NaN, Number.POSITIVE_INFINITY, 25n, null, undefined, {}])(
      'rejects non-string amount %p',
      (amount) => {
        expect(() => Money.from({ amount, currency: 'BRL' } as unknown as MoneyProps)).toThrow(InvalidMoneyAmountError);
      },
    );

    it.each([[['1.00']], [{ toString: (): string => '1.00' }]])('rejects string-coercible non-string amount %p', (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' } as unknown as MoneyProps)).toThrow(InvalidMoneyAmountError);
    });

    it.each(['', 'brl', 'BR', 'BRLL', ' BRL', 'BRL ', 'B1L', 'ÉUR'])('rejects currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidCurrencyError);
    });

    it('rejects a non-string currency', () => {
      expect(() => Money.from({ amount: '1.00', currency: 986 } as unknown as MoneyProps)).toThrow(
        InvalidCurrencyError,
      );
    });
  });

  describe('zero', () => {
    it('creates a zero amount in the given currency', () => {
      const zero = Money.zero('USD');
      expect(zero.toProps()).toEqual({ amount: '0.00', currency: 'USD' });
      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
    });

    it('validates the currency', () => {
      expect(() => Money.zero('usd')).toThrow(InvalidCurrencyError);
    });
  });

  describe('add', () => {
    it('is exact for decimal fractions (0.10 + 0.20 == 0.30)', () => {
      const sum = brl('0.10').add(brl('0.20'));
      expect(sum.toString()).toBe('0.30');
      expect(sum.equals(brl('0.30'))).toBe(true);
    });

    it('carries cents into the integer part', () => {
      expect(brl('0.99').add(brl('0.01')).toString()).toBe('1.00');
      expect(brl('25.50').add(brl('74.75')).toString()).toBe('100.25');
    });

    it('returns a new instance and keeps the operands untouched', () => {
      const a = brl('1.00');
      const b = brl('2.00');
      const sum = a.add(b);
      expect(sum).not.toBe(a);
      expect(a.toString()).toBe('1.00');
      expect(b.toString()).toBe('2.00');
    });

    it('reaches the maximum exactly', () => {
      expect(brl('999999999999999999.98').add(brl('0.01')).toString()).toBe(MAX);
    });

    it('rejects a sum above the maximum', () => {
      expect(() => brl(MAX).add(brl('0.01'))).toThrow(MoneyOverflowError);
    });

    it('rejects mixing currencies', () => {
      expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    });
  });

  describe('subtract', () => {
    it('subtracts exactly', () => {
      expect(brl('100.00').subtract(brl('25.01')).toString()).toBe('74.99');
      expect(brl('0.30').subtract(brl('0.10')).toString()).toBe('0.20');
    });

    it('allows reaching zero', () => {
      expect(brl('25.00').subtract(brl('25.00')).isZero()).toBe(true);
    });

    it('rejects a negative result', () => {
      expect(() => brl('1.00').subtract(brl('1.01'))).toThrow(NegativeMoneyError);
    });

    it('rejects mixing currencies', () => {
      expect(() => brl('2.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    });
  });

  describe('comparisons', () => {
    it('isGreaterThan / isGreaterThanOrEqual / isLessThan', () => {
      expect(brl('1.01').isGreaterThan(brl('1.00'))).toBe(true);
      expect(brl('1.00').isGreaterThan(brl('1.00'))).toBe(false);
      expect(brl('1.00').isGreaterThanOrEqual(brl('1.00'))).toBe(true);
      expect(brl('0.99').isGreaterThanOrEqual(brl('1.00'))).toBe(false);
      expect(brl('0.99').isLessThan(brl('1.00'))).toBe(true);
      expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    });

    it('compares by value, not by string length', () => {
      expect(brl('10.00').isGreaterThan(brl('9.99'))).toBe(true);
    });

    it.each([
      ['isGreaterThan', (a: Money, b: Money) => a.isGreaterThan(b)],
      ['isGreaterThanOrEqual', (a: Money, b: Money) => a.isGreaterThanOrEqual(b)],
      ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ])('%s rejects mixing currencies', (_name, compare) => {
      expect(() => compare(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
    });

    it('equals compares amount and currency', () => {
      expect(brl('25.00').equals(brl('25.00'))).toBe(true);
      expect(brl('25.00').equals(brl('25.01'))).toBe(false);
      expect(brl('25.00').equals(usd('25.00'))).toBe(false);
    });

    it('isZero / isPositive', () => {
      expect(brl('0.00').isZero()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.01').isZero()).toBe(false);
      expect(brl('0.01').isPositive()).toBe(true);
    });
  });

  describe('non-negativity', () => {
    it('exposes no API that negates or yields a negative amount', () => {
      const money = brl('25.00') as unknown as Record<string, unknown>;
      expect(money.negate).toBeUndefined();
      expect(money.isNegative).toBeUndefined();
    });

    it('rejects every subtraction that would go below zero', () => {
      expect(() => brl('0.00').subtract(brl('0.01'))).toThrow(NegativeMoneyError);
      expect(() => brl('10.00').subtract(brl('50.00'))).toThrow(NegativeMoneyError);
      expect(() => Money.zero('BRL').subtract(brl(MAX))).toThrow(NegativeMoneyError);
    });

    it('never parses a negative amount', () => {
      expect(() => brl('-40.00')).toThrow(InvalidMoneyAmountError);
    });

    it('serializes only amounts that from() accepts back', () => {
      for (const money of [brl('0.00'), brl('0.30').subtract(brl('0.30')), brl('1.00').add(brl('0.01')), brl(MAX)]) {
        expect(Money.from(money.toProps()).equals(money)).toBe(true);
      }
    });
  });

  describe('runtime immutability', () => {
    it('ignores or rejects writes to internals and fields', () => {
      const money = brl('25.00');
      const raw = money as unknown as Record<string, unknown>;
      expect(() => {
        raw.cents = 1n;
      }).toThrow(TypeError);
      expect(() => {
        raw.currency = 'USD';
      }).toThrow(TypeError);
      expect(() => {
        raw.amount = '99.00';
      }).toThrow(TypeError);
      expect(money.amount).toBe('25.00');
      expect(money.toProps()).toEqual({ amount: '25.00', currency: 'BRL' });
    });

    it('is frozen', () => {
      expect(Object.isFrozen(brl('1.00'))).toBe(true);
    });

    it('exposes only amount and currency, both strings, through spread or keys', () => {
      const money = brl('25.00');
      expect({ ...money }).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(Object.keys(money).sort()).toEqual(['amount', 'currency']);
      expect(Object.values(money).every((value) => typeof value === 'string')).toBe(true);
    });

    it('keeps amount in step with the arithmetic', () => {
      expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
      expect(brl('1.00').subtract(brl('0.01')).amount).toBe('0.99');
      expect(Money.zero('BRL').amount).toBe('0.00');
      expect(brl(MAX).amount).toBe(MAX);
    });
  });

  describe('structural equality', () => {
    it('toEqual sees the amount, not only the currency', () => {
      expect(brl('1.00')).not.toEqual(brl('2.00'));
      expect(brl('1.00')).toEqual(brl('1.00'));
      expect(brl('1.00')).not.toEqual(usd('1.00'));
      expect({ balance: brl('0.30') }).toEqual({ balance: brl('0.10').add(brl('0.20')) });
    });
  });

  describe('serialization', () => {
    it('toJSON returns the contract shape', () => {
      expect(JSON.stringify({ money: brl('25.00') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    });

    it('toProps returns a fresh object', () => {
      const money = brl('1.00');
      expect(money.toProps()).not.toBe(money.toProps());
    });
  });

  describe('CurrencyMismatchError', () => {
    it('carries the CURRENCY_MISMATCH failure code', () => {
      try {
        brl('1.00').add(usd('1.00'));
        throw new Error('expected CurrencyMismatchError');
      } catch (error) {
        expect(error).toBeInstanceOf(CurrencyMismatchError);
        expect((error as CurrencyMismatchError).failureCode).toBe(FailureCode.CURRENCY_MISMATCH);
        expect((error as CurrencyMismatchError).message).toContain('BRL');
        expect((error as CurrencyMismatchError).message).toContain('USD');
      }
    });
  });
});
