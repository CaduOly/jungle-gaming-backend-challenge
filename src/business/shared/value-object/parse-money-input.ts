import { InputRule } from '../error/input-rule';
import { InvalidCurrencyError } from '../error/invalid-currency-error';
import { InvalidRequestError } from '../error/invalid-request-error';
import { Money } from './money';

/**
 * Money from untrusted input, with the failure pinned to the exact field: `<field>.amount` or `<field>.currency`,
 * or `<field>` itself when there is no money object at all.
 */
export const parseMoneyInput = (money: unknown, field: string): Money => {
  if (typeof money !== 'object' || money === null) {
    throw new InvalidRequestError(field, 'must be an object with amount and currency');
  }
  try {
    return Money.from(money as Parameters<typeof Money.from>[0]);
  } catch (error) {
    if (error instanceof InvalidCurrencyError) {
      throw new InvalidRequestError(`${field}.currency`, error.message, InputRule.INVALID_CURRENCY);
    }
    throw new InvalidRequestError(`${field}.amount`, String(error), InputRule.INVALID_MONEY_AMOUNT);
  }
};
