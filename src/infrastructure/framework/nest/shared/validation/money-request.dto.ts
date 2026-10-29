import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString, ValidateBy } from 'class-validator';
import { Money } from '../../../../../business/shared/value-object/money';
import { ValidationDetailMessage } from '../i18n/validation.detail-message';
import { CURRENCY_PATTERN, MONEY_AMOUNT_PATTERN } from '../swagger/schemas';
import { withDetail } from './with-detail';

/**
 * Applied in this order, and class-validator runs them in the order they were applied. A custom rule needs a
 * non-empty default message: class-validator only attaches the context (the catalog entry) to a truthy one.
 */
const all = (...decorators: PropertyDecorator[]): PropertyDecorator => (target, key) =>
  decorators.forEach((decorator) => decorator(target, key));

/**
 * The format rules are Money's own (isValidAmount / isValidCurrency), checked here field by field so a request
 * with a bad amount and a bad currency hears about both, next to every other invalid field.
 */
export class MoneyRequestDto {
  @ApiProperty({ type: 'string', pattern: MONEY_AMOUNT_PATTERN, example: '25.00', description: 'Decimal string, never a number.' })
  @all(
    IsDefined(withDetail(ValidationDetailMessage.REQUIRED)),
    IsString(withDetail(ValidationDetailMessage.MUST_BE_STRING)),
    ValidateBy(
      { name: 'isMoneyAmount', validator: { validate: (value: unknown) => Money.isValidAmount(value), defaultMessage: () => 'amount' } },
      withDetail(ValidationDetailMessage.INVALID_MONEY_AMOUNT),
    ),
  )
  amount!: string;

  @ApiProperty({ type: 'string', pattern: CURRENCY_PATTERN, example: 'BRL' })
  @all(
    IsDefined(withDetail(ValidationDetailMessage.REQUIRED)),
    IsString(withDetail(ValidationDetailMessage.MUST_BE_STRING)),
    ValidateBy(
      { name: 'isCurrency', validator: { validate: (value: unknown) => Money.isValidCurrency(value), defaultMessage: () => 'currency' } },
      withDetail(ValidationDetailMessage.INVALID_CURRENCY),
    ),
  )
  currency!: string;
}
