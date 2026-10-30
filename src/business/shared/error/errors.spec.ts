import { describe, expect, it } from 'bun:test';
import { BusinessRuleError } from './business-rule-error';
import { CurrencyMismatchError } from './currency-mismatch-error';
import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';
import { InvalidCurrencyError } from './invalid-currency-error';
import { InvalidMoneyAmountError } from './invalid-money-amount-error';
import { InvalidTransactionStateError } from './invalid-transaction-state-error';
import { MoneyOverflowError } from './money-overflow-error';
import { NegativeMoneyError } from './negative-money-error';

class InsufficientFundsProbe extends BusinessRuleError {
  constructor() {
    super(FailureCode.INSUFFICIENT_FUNDS, 'not enough');
  }
}

describe('domain errors', () => {
  it('BusinessRuleError subclasses are DomainErrors carrying a failure code', () => {
    const error = new InsufficientFundsProbe();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(BusinessRuleError);
    expect(error.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(error.name).toBe('InsufficientFundsProbe');
    expect(error.message).toBe('not enough');
  });

  it('InvalidTransactionStateError describes the rejected transition', () => {
    const error = new InvalidTransactionStateError('PROCESSED', 'REJECTED');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('InvalidTransactionStateError');
    expect(error.from).toBe('PROCESSED');
    expect(error.to).toBe('REJECTED');
    expect(error.message).toContain('PROCESSED');
    expect(error.message).toContain('REJECTED');
  });

  it.each([
    ['InvalidMoneyAmountError', new InvalidMoneyAmountError('1e2')],
    ['InvalidCurrencyError', new InvalidCurrencyError('brl')],
    ['MoneyOverflowError', new MoneyOverflowError()],
    ['NegativeMoneyError', new NegativeMoneyError()],
  ])('%s is a DomainError without a failure code', (name, error) => {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).not.toBeInstanceOf(BusinessRuleError);
    expect(error.name).toBe(name);
  });

  it('CurrencyMismatchError is a BusinessRuleError', () => {
    const error = new CurrencyMismatchError('BRL', 'USD');
    expect(error).toBeInstanceOf(BusinessRuleError);
    expect(error.failureCode).toBe(FailureCode.CURRENCY_MISMATCH);
    expect(error.expected).toBe('BRL');
    expect(error.actual).toBe('USD');
  });

  it('invalid input errors quote the rejected value without leaking objects', () => {
    expect(new InvalidMoneyAmountError('1e2').message).toContain('"1e2"');
    expect(new InvalidMoneyAmountError(25).message).toContain('number');
    expect(new InvalidCurrencyError('brl').message).toContain('"brl"');
  });

  it('truncates long rejected input in the message', () => {
    const huge = '9'.repeat(1024 * 1024);
    const message = new InvalidMoneyAmountError(huge).message;
    expect(message).toContain(`"${'9'.repeat(32)}…"`);
    expect(message).not.toContain('9'.repeat(33));
    expect(message.length).toBeLessThan(200);
    expect(new InvalidCurrencyError(huge).message.length).toBeLessThan(200);
  });

  it('keeps input of exactly the limit untruncated', () => {
    const limit = 'x'.repeat(32);
    expect(new InvalidCurrencyError(limit).message).toContain(`"${limit}"`);
  });
});
