import { DomainError } from '../../../../../business/shared/error/domain-error';
import { InvalidCurrencyError } from '../../../../../business/shared/error/invalid-currency-error';
import { Money, type MoneyProps } from '../../../../../business/shared/value-object/money';
import { detail } from '../envelope/api-response';
import { HttpProblem } from '../errors/http-problem';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';

/**
 * The DTO only checks that amount and currency are strings; the format rule lives in Money.from alone, and
 * its error becomes a 400 detail on the exact field. The use case parses the same props again.
 */
export const toMoneyProps = (money: MoneyProps, field: string): MoneyProps => {
  try {
    return Money.from(money).toProps();
  } catch (error) {
    if (error instanceof InvalidCurrencyError) {
      throw new HttpProblem(400, [detail(ValidationDetailMessage.INVALID_CURRENCY, `${field}.currency`)]);
    }
    if (error instanceof DomainError) {
      throw new HttpProblem(400, [detail(ValidationDetailMessage.INVALID_MONEY_AMOUNT, `${field}.amount`)]);
    }
    throw error;
  }
};
